/**
 * Phase 4A — Durable Session Checkpointing tests.
 * Runs against REAL PostgreSQL (no mocks) per spec Section 8.
 * DB: postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory
 * Categories 8 (coexistence) and 9 (v1 regression) covered by compaction.test.ts.
 */

import { describe, it, before, after } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { Pool } from 'pg';
import { buildCheckpoint, type BuildInput } from '../dist/checkpoint-builder.js';
import { CheckpointStore } from '../dist/checkpoint-store.js';
import { buildCheckpointInjection } from '../dist/checkpoint-inject.js';
import { initializeCheckpointSchema } from '../dist/checkpoint-schema.js';
import { estimateTokens } from '../dist/token-bucket-analyzer.js';
import type { SessionMessage, CheckpointConfig } from '../dist/checkpoint-types.js';

const DB_URL = process.env.CSM_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory';
const TEST_SESSION = 'test-checkpoint-' + Date.now();

const CFG: CheckpointConfig = {
  enabled: true,
  maxCheckpointInjectTokens: 1200,
  minMessagesBeforeInject: 3,
  maxRawCaptureChars: 8192,
  maxRawCapturesPerCheckpoint: 50,
};

// Minimal pool for tests — satisfies DatabasePool shape
const pool = new Pool({ connectionString: DB_URL }) as any;

function mkUserMsg(text: string, id: string): SessionMessage {
  return { info: { id, role: 'user' }, parts: [{ type: 'text', text }] };
}

function mkAssistantMsg(text: string, id: string): SessionMessage {
  return { info: { id, role: 'assistant' }, parts: [{ type: 'text', text }] };
}

function mkToolMsg(id: string, toolCallId: string, output: string): SessionMessage {
  return {
    info: { id, role: 'assistant' },
    parts: [{ type: 'tool', toolCallId, state: { status: 'completed' }, output }],
  };
}

const TEST_MESSAGES: SessionMessage[] = [
  mkUserMsg('Build a checkpoint system for long sessions. Must use PostgreSQL. Never use SQLite.', 'm1'),
  mkAssistantMsg('I will create checkpoint-builder.ts. Done: schema approved.', 'm2'),
  mkToolMsg('m3', 'tool-call-1', 'result: 42 tests passed\n' + 'x'.repeat(2000)),
  mkAssistantMsg('Verified: 42/42 tests pass. [COMPACTED:tool-1] was the tool output.', 'm4'),
  mkUserMsg('Next: run integration test. Then deploy.', 'm5'),
];

describe('Phase 4A — Durable Session Checkpointing', () => {

  let store: CheckpointStore;

  before(async () => {
    await initializeCheckpointSchema(pool);
    store = new CheckpointStore(pool);
  });

  after(async () => {
    // Clean up test data
    await pool.query('DELETE FROM checkpoint_raw_captures WHERE checkpoint_id IN (SELECT checkpoint_id FROM checkpoints WHERE session_id = $1)', [TEST_SESSION]);
    await pool.query('DELETE FROM checkpoints WHERE session_id = $1', [TEST_SESSION]);
    await pool.end();
  });

  // Test 1: Checkpoint summary shape validation
  it('1. summary markdown has all required sections', () => {
    const input: BuildInput = {
      sessionId: TEST_SESSION,
      projectId: null,
      messages: TEST_MESSAGES,
      config: CFG,
    };
    const result = buildCheckpoint(input);
    const md = result.checkpoint.summaryMarkdown;
    const required = ['## Goal', '## Constraints', '## Current State',
      '## Completed Work', '## Decisions', '## Active Files',
      '## Tool / Test Evidence', '## Risks', '## Next Steps',
      '## Recoverable References'];
    for (const section of required) {
      ok(md.includes(section), `missing section: ${section}`);
    }
    ok(md.length > 50, 'summary too short');
    ok(result.checkpoint.summaryTokens > 0, 'summaryTokens must be positive');
  });

  // Test 2: Source range tracking
  it('2. sourceMessageStart and sourceMessageEnd are set to first/last message IDs', () => {
    const result = buildCheckpoint({
      sessionId: TEST_SESSION, projectId: null,
      messages: TEST_MESSAGES, config: CFG,
    });
    strictEqual(result.checkpoint.sourceMessageStart, 'm1');
    strictEqual(result.checkpoint.sourceMessageEnd, 'm5');
  });

  // Test 3: Compacted reference preservation
  it('3. [COMPACTED] markers are captured in compactedRefs', () => {
    const result = buildCheckpoint({
      sessionId: TEST_SESSION, projectId: null,
      messages: TEST_MESSAGES, config: CFG,
    });
    ok(result.checkpoint.compactedRefs.length > 0, 'no compacted refs captured');
    const ref = result.checkpoint.compactedRefs[0];
    ok(ref.marker.includes('[COMPACTED'), `marker wrong: ${ref.marker}`);
    ok(ref.expandHint.length > 0, 'expandHint must not be empty');
  });

  // Test 4: Latest-checkpoint injection budget
  it('4. injection stays under maxCheckpointInjectTokens', async () => {
    // First store a checkpoint
    const built = buildCheckpoint({
      sessionId: TEST_SESSION, projectId: null,
      messages: TEST_MESSAGES, config: CFG,
    });
    await store.createCheckpoint(built.checkpoint);
    // Then attempt injection
    const injection = await buildCheckpointInjection({ store, config: CFG }, TEST_SESSION);
    ok(injection !== null, 'injection should not be null when active checkpoint exists');
    ok(injection!.length > 0, 'injection text must not be empty');
    ok(estimateTokens(injection!) <= CFG.maxCheckpointInjectTokens,
      `injection ${estimateTokens(injection!)} exceeds budget ${CFG.maxCheckpointInjectTokens}`);
  });

  // Test 5: Superseded checkpoint handling (is_active flag — architect fix)
  it('5. new checkpoint supersedes old — only one is_active=true', async () => {
    const sid = TEST_SESSION + '-supersede';
    const built1 = buildCheckpoint({
      sessionId: sid, projectId: null,
      messages: TEST_MESSAGES, config: CFG,
    });
    const rec1 = await store.createCheckpoint(built1.checkpoint);
    ok(rec1.isActive, 'first checkpoint should be active');
    const built2 = buildCheckpoint({
      sessionId: sid, projectId: null,
      messages: [...TEST_MESSAGES, mkUserMsg('Follow-up message', 'm6')],
      config: CFG,
    });
    const rec2 = await store.createCheckpoint(built2.checkpoint);
    ok(rec2.isActive, 'second checkpoint should be active');
    strictEqual(rec2.supersedesCheckpointId, rec1.checkpointId,
      'second checkpoint must point back to first');
    const active = await store.getActiveCheckpoint(sid);
    ok(active !== null, 'should have an active checkpoint');
    strictEqual(active!.checkpointId, rec2.checkpointId,
      'active checkpoint must be the latest, not the first');
    const list = await store.listCheckpoints(sid, 10);
    strictEqual(list.length, 2, 'should have 2 checkpoints total');
    // Cleanup
    await pool.query('DELETE FROM checkpoint_raw_captures WHERE checkpoint_id IN (SELECT checkpoint_id FROM checkpoints WHERE session_id = $1)', [sid]);
    await pool.query('DELETE FROM checkpoints WHERE session_id = $1', [sid]);
  });

  // Test 6: Recovery/expand behavior
  it('6. expandRef retrieves raw capture by tool_call_id', async () => {
    const sid = TEST_SESSION + '-expand';
    const built = buildCheckpoint({
      sessionId: sid, projectId: null,
      messages: TEST_MESSAGES, config: CFG,
    });
    const rec = await store.createCheckpoint(built.checkpoint);
    ok(built.checkpoint.rawCaptures.length > 0, 'should have raw captures');
    // Expand by tool call ID
    const expanded = await store.expandRef(sid, 'tool-call-1');
    ok(expanded.found, 'expand should find the capture');
    ok(expanded.rawCapture !== undefined, 'rawCapture should be defined');
    ok(expanded.rawCapture!.content.includes('42 tests passed'),
      'expanded content must match original tool output');
    // Cleanup
    await pool.query('DELETE FROM checkpoint_raw_captures WHERE checkpoint_id IN (SELECT checkpoint_id FROM checkpoints WHERE session_id = $1)', [sid]);
    await pool.query('DELETE FROM checkpoints WHERE session_id = $1', [sid]);
  });

  // Test 7: No mutation of original messages
  it('7. builder does not mutate input messages', () => {
    const msgs: SessionMessage[] = [
      mkUserMsg('Original text that should not change', 'orig-1'),
      mkAssistantMsg('Assistant response stays intact', 'orig-2'),
    ];
    // Deep clone for comparison
    const before = JSON.parse(JSON.stringify(msgs));
    buildCheckpoint({
      sessionId: TEST_SESSION, projectId: null,
      messages: msgs, config: CFG,
    });
    deepStrictEqual(msgs, before, 'input messages were mutated');
  });
});

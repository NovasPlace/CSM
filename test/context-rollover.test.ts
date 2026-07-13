/**
 * Phase 6 — Context Rollover: unit + integration tests.
 *
 * Tests:
 * 1. Rollover trigger (cumulative tokens exceed threshold)
 * 2. No-rollover path (below threshold)
 * 3. Archived context (old messages archived to cache)
 * 4. Continuation brief content (carries goal, files, errors, constraints)
 * 5. Transformed message validity (message shape preserved after rollover)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';

import {
  buildContinuationBrief,
  type ContinuationBrief,
} from '../dist/context-rollover-brief.js';
import { DEFAULT_ROLLOVER_CONFIG } from '../dist/context-rollover-config.js';
import type { RolloverConfig } from '../dist/context-rollover-config.js';
import { initializeRolloverSchema } from '../dist/context-rollover-schema.js';
import { initializeContextCacheSchema } from '../dist/context-cache-schema.js';
import { performRollover } from '../dist/context-rollover.js';
import {
  getRolloverRecord,
  setHardRolloverFlag,
  clearHardRolloverFlag,
} from '../dist/context-rollover-schema.js';
import type { DatabasePool } from '../dist/types.js';

/* ── Helper: build a mock message ──────────────────────────────────── */

interface MockPart {
  type: string;
  text?: string;
  tool?: string;
  input?: unknown;
  output?: string;
  state?: string;
}

interface MockMessage {
  info?: { role?: string; sessionID?: string };
  parts?: MockPart[];
}

function userMsg(text: string, sessionId = 'sess-test'): MockMessage {
  return { info: { role: 'user', sessionID: sessionId }, parts: [{ type: 'text', text }] };
}

function assistantMsg(text: string, sessionId = 'sess-test'): MockMessage {
  return { info: { role: 'assistant', sessionID: sessionId }, parts: [{ type: 'text', text }] };
}

function toolMsg(
  tool: string,
  output: string,
  state: string = 'completed',
  sessionId = 'sess-test',
): MockMessage {
  return {
    info: { role: 'assistant', sessionID: sessionId },
    parts: [{ type: 'tool', tool, input: {}, output, state }],
  };
}

function buildBigMessages(n: number, textLen = 5000): MockMessage[] {
  const msgs: MockMessage[] = [];
  const text = 'A'.repeat(textLen);
  for (let i = 0; i < n; i++) {
    msgs.push(userMsg(text, `big-sess-${i}`));
    msgs.push(assistantMsg(text, `big-sess-${i}`));
  }
  return msgs;
}

/* ── DB setup ──────────────────────────────────────────────────────── */

let pool: Pool;
let dbPool: DatabasePool;

before(async () => {
  pool = new Pool({
    connectionString: process.env.CSM_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/cross_session_memory',
    max: 2,
  });
  dbPool = {
    query: (text: string, params?: unknown[]) => pool.query(text, params),
    connect: () => pool.connect() as any,
    end: () => pool.end(),
  };
  await initializeRolloverSchema(dbPool);
  await initializeContextCacheSchema(dbPool);
});

after(async () => {
  await pool.end();
});

/* ── Unit tests (no DB) ───────────────────────────────────────────── */

describe('buildContinuationBrief', () => {
  it('extracts active goal from last user message', () => {
    const messages: MockMessage[] = [
      userMsg('Implement soft rollover'),
      assistantMsg('Working on it'),
    ];
    const brief = buildContinuationBrief(messages as any, DEFAULT_ROLLOVER_CONFIG, 'sess-1');
    assert.ok(brief.text.includes('Implement soft rollover'), 'brief contains user goal');
    assert.ok(brief.tokens > 0, 'brief has token count');
  });

  it('extracts active files from tool calls', () => {
    const messages: MockMessage[] = [
      userMsg('Edit index.ts'),
      toolMsg('edit', 'File edited successfully', 'completed'),
      assistantMsg('Done'),
    ];
    const brief = buildContinuationBrief(messages as any, DEFAULT_ROLLOVER_CONFIG, 'sess-1');
    assert.ok(brief.text.includes('Active Files'), 'brief section exists');
  });

  it('extracts errors from tool outputs', () => {
    const messages: MockMessage[] = [
      userMsg('Run tests'),
      toolMsg('bash', 'Error: test failed at line 42', 'completed'),
      assistantMsg('Tests failed'),
    ];
    const brief = buildContinuationBrief(messages as any, DEFAULT_ROLLOVER_CONFIG, 'sess-1');
    assert.ok(brief.text.includes('Latest Errors'), 'errors section exists');
  });

  it('handles empty messages array', () => {
    const brief = buildContinuationBrief([], DEFAULT_ROLLOVER_CONFIG, 'sess-1');
    assert.ok(brief.text.length > 0, 'brief is not empty even with no messages');
    assert.ok(brief.tokens > 0, 'brief has token count');
  });

  it('brief is always under maxBriefTokens', () => {
    const longText = 'x'.repeat(20000);
    const messages: MockMessage[] = [
      userMsg(longText),
      assistantMsg(longText),
      toolMsg('bash', longText),
    ];
    const brief = buildContinuationBrief(
      messages as any,
      { ...DEFAULT_ROLLOVER_CONFIG, maxBriefTokens: 500 },
      'sess-1',
    );
    assert.ok(brief.tokens <= 600, `brief tokens ${brief.tokens} should be near maxBriefTokens 500`);
  });

  it('includes user constraints', () => {
    const messages: MockMessage[] = [
      userMsg('Do something'),
    ];
    const brief = buildContinuationBrief(messages as any, DEFAULT_ROLLOVER_CONFIG, 'sess-1');
    assert.ok(brief.text.includes('User Constraints'), 'constraints section exists');
  });
});

describe('RolloverConfig defaults', () => {
  it('has sensible default thresholds', () => {
    const cfg = DEFAULT_ROLLOVER_CONFIG;
    assert.ok(cfg.rolloverAtTotalSessionTokens > 0);
    assert.ok(cfg.targetInputTokensAfterRollover > 0);
    assert.ok(cfg.failClosedOverInputTokens > cfg.targetInputTokensAfterRollover);
    assert.ok(cfg.recentTurnsToKeep >= 1);
    assert.ok(cfg.maxBriefTokens > 0);
    assert.equal(cfg.enabled, true);
  });
});

describe('ContinuationBrief structure', () => {
  it('has text and tokens fields', () => {
    const brief = buildContinuationBrief(
      [userMsg('hello')],
      DEFAULT_ROLLOVER_CONFIG,
      'sess-1',
    );
    assert.equal(typeof brief.text, 'string');
    assert.equal(typeof brief.tokens, 'number');
    assert.ok(brief.text.length > 0);
    assert.ok(brief.tokens > 0);
  });

  it('carries context from multi-turn conversation', () => {
    const messages: MockMessage[] = [
      userMsg('Build a parser'),
      assistantMsg('Starting with lexer'),
      toolMsg('edit', 'Created lexer.ts', 'completed'),
      assistantMsg('Lexer done'),
      userMsg('Now add tests'),
      toolMsg('bash', 'Error: 3 tests failing', 'completed'),
    ];
    const brief = buildContinuationBrief(messages as any, DEFAULT_ROLLOVER_CONFIG, 'sess-1');
    assert.ok(brief.text.length > 50, 'brief has substantial content');
  });
});

/* ── DB integration tests ──────────────────────────────────────────── */

describe('performRollover (DB integration)', () => {
  it('no-rollover path: below threshold returns original messages unchanged', async () => {
    const sessionId = `no-rollover-${Date.now()}`;
    const msgs: MockMessage[] = [
      userMsg('Hello', sessionId),
      assistantMsg('Hi there', sessionId),
    ];
    const cfg: RolloverConfig = {
      ...DEFAULT_ROLLOVER_CONFIG,
      rolloverAtTotalSessionTokens: 999_999, // very high threshold
    };
    const result = await performRollover(dbPool, sessionId, msgs as any, 100, cfg);
    assert.equal(result.rolloverTriggered, false, 'should not trigger rollover');
    assert.equal(result.messages.length, 2, 'messages unchanged');
    assert.ok(result.cumulativeTokens > 0, 'cumulative updated');
  });

  it('rollover trigger: exceeding threshold triggers rollover and replaces messages', async () => {
    const sessionId = `rollover-trigger-${Date.now()}`;
    const msgs: MockMessage[] = [
      userMsg('Build a parser', sessionId),
      assistantMsg('Starting', sessionId),
      toolMsg('edit', 'Created file', 'completed', sessionId),
      assistantMsg('Done', sessionId),
      userMsg('Now test it', sessionId),
      assistantMsg('Running tests', sessionId),
    ];
    // Very low threshold to guarantee trigger
    const cfg: RolloverConfig = {
      ...DEFAULT_ROLLOVER_CONFIG,
      rolloverAtTotalSessionTokens: 10,
      recentTurnsToKeep: 1,
    };
    const result = await performRollover(dbPool, sessionId, msgs as any, 500, cfg);
    assert.equal(result.rolloverTriggered, true, 'rollover triggered');
    assert.ok(result.messages.length < msgs.length, `messages reduced: ${result.messages.length} < ${msgs.length}`);
    assert.ok(result.briefTokens > 0, 'brief was generated');
    assert.ok(result.archivedTokens > 0, 'old messages archived');
    // First message should be the synthetic brief with a valid SDK chat role
    assert.ok(
      result.messages[0].info?.role === 'assistant' || result.messages[0].info?.role === 'user',
      `first message has valid synthetic role: ${result.messages[0].info?.role}`,
    );
    // Remaining messages should be recent turns
    const lastMsg = result.messages[result.messages.length - 1];
    assert.equal(lastMsg.info?.role, 'assistant', 'last message is assistant');
  });

  it('archived context: old messages stored in context_cache DB', async () => {
    const sessionId = `archive-test-${Date.now()}`;
    const msgs: MockMessage[] = [
      userMsg('Old task context', sessionId),
      assistantMsg('Working on old task', sessionId),
      toolMsg('read', 'file content from old turn', 'completed', sessionId),
      assistantMsg('Completed old turn', sessionId),
      userMsg('New task', sessionId),
      assistantMsg('Starting new task', sessionId),
    ];
    const cfg: RolloverConfig = {
      ...DEFAULT_ROLLOVER_CONFIG,
      rolloverAtTotalSessionTokens: 5,
      recentTurnsToKeep: 1,
    };
    const result = await performRollover(dbPool, sessionId, msgs as any, 200, cfg);
    assert.equal(result.rolloverTriggered, true, 'rollover triggered');

    // Query context_cache to verify old messages were archived
    const cacheResult = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM context_cache WHERE session_id = $1',
      [sessionId],
    );
    assert.ok(cacheResult.rows[0].cnt > 0, 'archived items exist in context_cache');
  });

  it('transformed message validity: preserved roles and structure', async () => {
    const sessionId = `validity-test-${Date.now()}`;
    const msgs: MockMessage[] = [
      userMsg('Task 1', sessionId),
      assistantMsg('Working', sessionId),
      toolMsg('bash', 'output 1', 'completed', sessionId),
      assistantMsg('Done', sessionId),
      userMsg('Task 2', sessionId),
      assistantMsg('Working on task 2', sessionId),
    ];
    const cfg: RolloverConfig = {
      ...DEFAULT_ROLLOVER_CONFIG,
      rolloverAtTotalSessionTokens: 5,
      recentTurnsToKeep: 1,
    };
    const result = await performRollover(dbPool, sessionId, msgs as any, 200, cfg);
    assert.equal(result.rolloverTriggered, true, 'rollover triggered');

    const transformed = result.messages;
    // Brief uses a valid SDK chat role
    assert.ok(transformed[0].info?.role === 'assistant' || transformed[0].info?.role === 'user');
    assert.ok(transformed[0].parts?.length === 1, 'brief has exactly 1 part');
    assert.equal(transformed[0].parts![0].type, 'text', 'brief part is text');
    // Rest of messages have valid roles
    for (let i = 1; i < transformed.length; i++) {
      const role = transformed[i].info?.role;
      assert.ok(
        role === 'user' || role === 'assistant',
        `message ${i} has valid role: ${role}`,
      );
    }
    // No two consecutive user messages
    for (let i = 1; i < transformed.length; i++) {
      const prev = transformed[i - 1].info?.role;
      const curr = transformed[i].info?.role;
      if (i === 1 && prev !== 'user' && prev !== 'assistant') continue;
      assert.ok(
        !(prev === 'user' && curr === 'user'),
        `no consecutive user messages at ${i - 1},${i}`,
      );
    }
  });

  it('prompt size drops: new prompt is significantly smaller than original', async () => {
    const sessionId = `size-drop-${Date.now()}`;
    // Build a big conversation: 20 turns of 5000-char messages
    const msgs: MockMessage[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(userMsg('A'.repeat(5000), sessionId));
      msgs.push(assistantMsg('B'.repeat(5000), sessionId));
    }
    const originalTokenCount = msgs.reduce((acc, m) => {
      const text = (m.parts || []).map(p => p.text || p.output || '').join('');
      return acc + Math.ceil(text.length / 4);
    }, 0);

    const cfg: RolloverConfig = {
      ...DEFAULT_ROLLOVER_CONFIG,
      rolloverAtTotalSessionTokens: 5, // trigger immediately
      recentTurnsToKeep: 2, // keep 2 turns
    };
    const result = await performRollover(dbPool, sessionId, msgs as any, originalTokenCount, cfg);
    assert.equal(result.rolloverTriggered, true, 'rollover triggered');

    // New prompt tokens should be much less than original
    assert.ok(
      result.newPromptTokens < originalTokenCount * 0.5,
      `new prompt ${result.newPromptTokens} should be < 50% of original ${originalTokenCount}`,
    );
    assert.ok(
      result.messages.length < msgs.length,
      `messages reduced: ${result.messages.length} from ${msgs.length}`,
    );
  });
});

/* ── Phase 2: Hard rollover flag tests ──────────────────────────────── */

describe('Phase 2: Hard rollover flag', () => {
  it('sets hard rollover flag on fail-closed', async () => {
    const sessionId = `fail-closed-${Date.now()}`;
    // Need more messages than recentTurnsToKeep so old messages exist to archive
    const msgs: MockMessage[] = [
      userMsg('Old task 1', sessionId),
      assistantMsg('Working on old', sessionId),
      userMsg('Old task 2', sessionId),
      assistantMsg('Still working', sessionId),
      userMsg('Current task', sessionId),
      assistantMsg('Working on current', sessionId),
    ];
    const cfg: RolloverConfig = {
      ...DEFAULT_ROLLOVER_CONFIG,
      rolloverAtTotalSessionTokens: 1,
      failClosedOverInputTokens: 1, // impossibly low → always fail-closed
      recentTurnsToKeep: 1, // keep only the last user-assistant pair
    };
    const result = await performRollover(dbPool, sessionId, msgs as any, 5000, cfg);
    assert.equal(result.failClosed, true, 'fail-closed triggered');
    assert.equal(result.rolloverTriggered, true, 'rollover triggered');

    // Verify flag was set in DB
    const record = await getRolloverRecord(dbPool, sessionId);
    assert.equal(record.needs_hard_rollover, true, 'hard rollover flag is set');
    assert.ok(record.last_brief_text && record.last_brief_text.length > 0, 'brief text stored');
  });

  it('clears hard rollover flag via clearHardRolloverFlag', async () => {
    const sessionId = `clear-flag-${Date.now()}`;
    // First create the row via performRollover so the row exists
    const msgs: MockMessage[] = [
      userMsg('Task 1', sessionId),
      assistantMsg('Working', sessionId),
      userMsg('Task 2', sessionId),
      assistantMsg('Still working', sessionId),
    ];
    const cfg: RolloverConfig = {
      ...DEFAULT_ROLLOVER_CONFIG,
      rolloverAtTotalSessionTokens: 1,
      failClosedOverInputTokens: 1,
      recentTurnsToKeep: 1,
    };
    await performRollover(dbPool, sessionId, msgs as any, 5000, cfg);
    const before = await getRolloverRecord(dbPool, sessionId);
    assert.equal(before.needs_hard_rollover, true, 'flag set after fail-closed');

    await clearHardRolloverFlag(dbPool, sessionId);
    const after = await getRolloverRecord(dbPool, sessionId);
    assert.equal(after.needs_hard_rollover, false, 'flag cleared');
  });

  it('does not set flag when not fail-closed', async () => {
    const sessionId = `no-flag-${Date.now()}`;
    const msgs: MockMessage[] = [
      userMsg('Task', sessionId),
      assistantMsg('Working', sessionId),
    ];
    const cfg: RolloverConfig = {
      ...DEFAULT_ROLLOVER_CONFIG,
      rolloverAtTotalSessionTokens: 999_999,
      failClosedOverInputTokens: 999_999,
    };
    const result = await performRollover(dbPool, sessionId, msgs as any, 100, cfg);
    assert.equal(result.rolloverTriggered, false, 'no rollover');
    assert.equal(result.failClosed, false, 'no fail-closed');

    const record = await getRolloverRecord(dbPool, sessionId);
    assert.equal(record.needs_hard_rollover, false, 'no flag set');
  });
});

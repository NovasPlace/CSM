import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { CheckpointStore } from '../dist/checkpoint-store.js';
import { buildCheckpointInjection } from '../dist/checkpoint-inject.js';
import { initializeCheckpointSchema } from '../dist/checkpoint-schema.js';
import { estimateTokens } from '../dist/token-bucket-analyzer.js';
import type { CheckpointConfig } from '../dist/checkpoint-types.js';

const DB_URL = process.env.CSM_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory';
const SESSION_ID = `test-checkpoint-budget-${Date.now()}`;
const CFG: CheckpointConfig = {
  enabled: true,
  maxCheckpointInjectTokens: 1200,
  minMessagesBeforeInject: 3,
  maxRawCaptureChars: 8192,
  maxRawCapturesPerCheckpoint: 50,
};

describe('buildCheckpointInjection budget compaction', () => {
  const pool = new Pool({ connectionString: DB_URL }) as any;
  let store: CheckpointStore;

  before(async () => {
    await initializeCheckpointSchema(pool);
    store = new CheckpointStore(pool);
  });

  after(async () => {
    await pool.query('DELETE FROM checkpoint_raw_captures WHERE checkpoint_id IN (SELECT checkpoint_id FROM checkpoints WHERE session_id = $1)', [SESSION_ID]);
    await pool.query('DELETE FROM checkpoints WHERE session_id = $1', [SESSION_ID]);
    await pool.end();
  });

  it('keeps signal lines when summary markdown is oversized', async () => {
    await store.createCheckpoint({
      sessionId: SESSION_ID,
      projectId: null,
      summaryMarkdown: [
        '## Goal',
        'Preserve continuity under token pressure.',
        '## Current State',
        `Files: src/context-budget-governor.ts, test/context-budget-governor-policy.test.ts ${'x'.repeat(4000)}`,
        '## Risks',
        'Failed test: prompt budget mismatch',
        '## Next Steps',
        'Wire checkpoint and resume injection through compact state.',
      ].join('\n'),
      summaryTokens: 2000,
      inputTokensEstimate: 2000,
      sourceRefs: [],
      compactedRefs: [],
      filesMentioned: ['src/context-budget-governor.ts'],
      testsMentioned: ['test/context-budget-governor-policy.test.ts'],
      risks: ['prompt budget mismatch'],
      nextSteps: ['Wire checkpoint injection'],
      rawCaptures: [],
    });

    const injection = await buildCheckpointInjection({ store, config: CFG }, SESSION_ID);
    assert.ok(injection);
    assert.equal(estimateTokens(injection!) <= CFG.maxCheckpointInjectTokens, true);
    assert.match(injection!, /Failed test: prompt budget mismatch/);
    assert.match(injection!, /## Goal/);
  });
});

/**
 * Phase 4B — Auto-Checkpoint Triggers integration test.
 * Runs against REAL PostgreSQL (no mocks) per spec Section 8.
 * DB: postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory
 */

import { describe, it, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { Pool } from 'pg';
import { CheckpointStore } from '../dist/checkpoint-store.js';
import { createAutoCheckpoint, type AutoCheckpointTrigger } from '../dist/helpers/auto-checkpoint.js';
import { initializeCheckpointSchema } from '../dist/checkpoint-schema.js';
import type { CheckpointConfig } from '../dist/checkpoint-types.js';

const DB_URL = process.env.CSM_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory';
const TEST_SESSION = 'test-auto-checkpoint-' + Date.now();

const CFG: CheckpointConfig = {
  enabled: true,
  maxCheckpointInjectTokens: 1200,
  minMessagesBeforeInject: 3,
  maxRawCaptureChars: 8192,
  maxRawCapturesPerCheckpoint: 50,
  auto: {
    enabled: true,
    contextPressureThreshold: 0.8,
    messageCountThreshold: 50,
    riskyEditToolPatterns: ['write', 'edit', 'delete', 'bash'],
  },
};

const pool = new Pool({ connectionString: DB_URL }) as any;

describe('Phase 4B — Auto-Checkpoint Triggers', () => {

  let store: CheckpointStore;

  before(async () => {
    await initializeCheckpointSchema(pool);
    store = new CheckpointStore(pool);
  });

  after(async () => {
    await pool.query('DELETE FROM checkpoints WHERE session_id = $1', [TEST_SESSION]);
    await pool.end();
  });

  it('1. context_pressure trigger creates checkpoint', async () => {
    const ctx = { checkpointStore: store, config: CFG };
    await createAutoCheckpoint(ctx, TEST_SESSION, 'context_pressure', {
      pressure: 0.85,
      threshold: 0.8,
    });
    const result = await pool.query(
      'SELECT summary_markdown FROM checkpoints WHERE session_id = $1 AND summary_markdown LIKE $2',
      [TEST_SESSION, '%context_pressure%'],
    );
    ok(result.rows.length > 0, 'context_pressure checkpoint should exist');
  });

  it('2. message_count trigger creates checkpoint', async () => {
    const ctx = { checkpointStore: store, config: CFG };
    await createAutoCheckpoint(ctx, TEST_SESSION, 'message_count', {
      messageCount: 50,
      threshold: 50,
    });
    const result = await pool.query(
      'SELECT summary_markdown FROM checkpoints WHERE session_id = $1 AND summary_markdown LIKE $2',
      [TEST_SESSION, '%message_count%'],
    );
    ok(result.rows.length > 0, 'message_count checkpoint should exist');
  });

  it('3. risky_edit trigger creates checkpoint', async () => {
    const ctx = { checkpointStore: store, config: CFG };
    await createAutoCheckpoint(ctx, TEST_SESSION, 'risky_edit', {
      tool: 'write',
      args: { path: 'src/schema.sql' },
    });
    const result = await pool.query(
      'SELECT summary_markdown FROM checkpoints WHERE session_id = $1 AND summary_markdown LIKE $2',
      [TEST_SESSION, '%risky_edit%'],
    );
    ok(result.rows.length > 0, 'risky_edit checkpoint should exist');
  });

  it('4. pre_compaction trigger creates checkpoint', async () => {
    const ctx = { checkpointStore: store, config: CFG };
    await createAutoCheckpoint(ctx, TEST_SESSION, 'pre_compaction', {
      model: 'gpt-4',
      buffer: 20000,
    });
    const result = await pool.query(
      'SELECT summary_markdown FROM checkpoints WHERE session_id = $1 AND summary_markdown LIKE $2',
      [TEST_SESSION, '%pre_compaction%'],
    );
    ok(result.rows.length > 0, 'pre_compaction checkpoint should exist');
  });

  it('5. auto-checkpoint disabled does nothing', async () => {
    const disabledCfg = { ...CFG, auto: { ...CFG.auto!, enabled: false } };
    const ctx = { checkpointStore: store, config: disabledCfg };
    const before = await pool.query('SELECT COUNT(*) FROM checkpoints WHERE session_id = $1', [TEST_SESSION]);
    await createAutoCheckpoint(ctx, TEST_SESSION, 'context_pressure', { pressure: 0.99 });
    const after = await pool.query('SELECT COUNT(*) FROM checkpoints WHERE session_id = $1', [TEST_SESSION]);
    strictEqual(before.rows[0].count, after.rows[0].count, 'no checkpoint when disabled');
  });

  it('6. all 5 trigger types produce distinct checkpoints', async () => {
    const triggers: AutoCheckpointTrigger[] = ['context_pressure', 'message_count', 'risky_edit', 'pre_compaction', 'post_compaction'];
    const ctx = { checkpointStore: store, config: CFG };
    for (const trigger of triggers) {
      await createAutoCheckpoint(ctx, TEST_SESSION + '-distinct', trigger, { test: true });
    }
    const result = await pool.query(
      'SELECT DISTINCT summary_markdown FROM checkpoints WHERE session_id = $1',
      [TEST_SESSION + '-distinct'],
    );
    ok(result.rows.length >= 5, 'should have 5 distinct checkpoints');
    await pool.query('DELETE FROM checkpoints WHERE session_id = $1', [TEST_SESSION + '-distinct']);
  });
});

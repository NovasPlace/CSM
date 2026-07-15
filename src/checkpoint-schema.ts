// Phase 4A — Durable Session Checkpointing schema
// Additive only. Called from Database.initializeSchema() via one line.
// PostgreSQL 14+. UUID via gen_random_uuid(). JSONB for structured columns.

import { DatabasePool } from './types.js';

// Bump when summary_markdown shape changes in a backwards-incompatible way.
export const CHECKPOINT_SCHEMA_VERSION = 1;

/**
 * Idempotent: safe to run on every plugin start. Creates two tables:
 *   checkpoints          — durable structured session summaries
 *   checkpoint_raw_captures — original raw content captured for recovery
 *
 * Design notes:
 *  - session_id is TEXT with no FK to sessions(id). This follows the
 *    compaction_metrics pattern (not distilled_summaries) so a checkpoint
 *    survives even if the OpenCode sessions row is pruned. Checkpoints are
 *    durable; the sessions table is OpenCode-owned.
 *  - is_active BOOLEAN makes "latest active checkpoint" queries unambiguous
 *    and cheap to index (partial index). On new checkpoint, all prior rows
 *    for the session are flipped to is_active=false.
 *  - supersedes_checkpoint_id is retained for audit lineage but is NOT used
 *    to find the latest (the architect-corrected design).
 */
export async function initializeCheckpointSchema(pool: DatabasePool): Promise<void> {
  // ── checkpoints table ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      checkpoint_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id TEXT NOT NULL,
      project_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      source_message_start TEXT,
      source_message_end TEXT,
      summary_markdown TEXT NOT NULL,
      summary_tokens INT NOT NULL,
      input_tokens_estimate INT NOT NULL,
      source_refs JSONB NOT NULL DEFAULT '[]',
      compacted_refs JSONB NOT NULL DEFAULT '[]',
      files_mentioned TEXT[] DEFAULT '{}',
      tests_mentioned TEXT[] DEFAULT '{}',
      risks JSONB NOT NULL DEFAULT '[]',
      next_steps JSONB NOT NULL DEFAULT '[]',
      supersedes_checkpoint_id UUID REFERENCES checkpoints(checkpoint_id),
      schema_version INT NOT NULL DEFAULT ${CHECKPOINT_SCHEMA_VERSION},
      is_active BOOLEAN NOT NULL DEFAULT true
    )
  `);

  // ── checkpoint_raw_captures table (recovery store) ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS checkpoint_raw_captures (
      raw_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      checkpoint_id UUID NOT NULL REFERENCES checkpoints(checkpoint_id) ON DELETE CASCADE,
      message_id TEXT,
      part_id TEXT,
      tool_call_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('tool_output', 'assistant_text', 'user_text')),
      content TEXT NOT NULL,
      token_count INT NOT NULL,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // ── Indexes (at least one per FK + hot query paths) ──
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_checkpoints_active
     ON checkpoints(session_id, created_at DESC)
     WHERE is_active = true`
  );
  await pool.query(`
    WITH ranked AS (
      SELECT checkpoint_id,
             ROW_NUMBER() OVER (
               PARTITION BY session_id
               ORDER BY created_at DESC, checkpoint_id DESC
             ) AS active_rank
      FROM checkpoints
      WHERE is_active = true
    )
    UPDATE checkpoints AS c
    SET is_active = false
    FROM ranked AS r
    WHERE c.checkpoint_id = r.checkpoint_id AND r.active_rank > 1
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_checkpoints_one_active
     ON checkpoints(session_id)
     WHERE is_active = true`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_checkpoints_created ON checkpoints(created_at DESC)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_checkpoints_project ON checkpoints(project_id)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_raw_captures_checkpoint
     ON checkpoint_raw_captures(checkpoint_id)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_raw_captures_message
     ON checkpoint_raw_captures(message_id)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_raw_captures_part
     ON checkpoint_raw_captures(part_id)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_raw_captures_tool_call
     ON checkpoint_raw_captures(tool_call_id)`
  );
}

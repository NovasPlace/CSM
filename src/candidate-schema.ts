import type { DatabasePool } from './types.js';
import { getLogger } from './logger.js';

export const ALL_CANDIDATE_TYPES = [
  'prune',
  'promote_to_lesson',
  'merge',
  'stale_preference',
  'refresh_summary',
  'candidate_belief',
  'candidate_preference',
  'candidate_worldview',
  'candidate_drift_warning',
  'candidate_opinion',
] as const;

export type CandidateType = (typeof ALL_CANDIDATE_TYPES)[number];

export const BELIEF_CANDIDATE_TYPES = [
  'candidate_belief',
  'candidate_preference',
  'candidate_worldview',
  'candidate_drift_warning',
  'candidate_opinion',
] as const;

export type BeliefCandidateType = (typeof BELIEF_CANDIDATE_TYPES)[number];

export async function initializeCandidateSchema(pool: DatabasePool): Promise<void> {
  const typeList = ALL_CANDIDATE_TYPES.map(t => `'${t}'`).join(', ');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_candidate_queue (
      id BIGSERIAL PRIMARY KEY,
      candidate_type TEXT NOT NULL CHECK (candidate_type IN (
        'prune', 'promote_to_lesson', 'merge', 'stale_preference', 'refresh_summary'
      )),
      memory_id BIGINT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
      source_signals JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'reviewed', 'dismissed', 'applied'
      ))
    )
  `);

  await pool.query(`ALTER TABLE memory_candidate_queue ADD COLUMN IF NOT EXISTS dedup_key TEXT`);
  await pool.query(`ALTER TABLE memory_candidate_queue ADD COLUMN IF NOT EXISTS event_count INTEGER NOT NULL DEFAULT 1`);
  await pool.query(`ALTER TABLE memory_candidate_queue ADD COLUMN IF NOT EXISTS reinforcement_count INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE memory_candidate_queue ADD COLUMN IF NOT EXISTS contradicted_count INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE memory_candidate_queue ADD COLUMN IF NOT EXISTS last_reinforced_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE memory_candidate_queue ADD COLUMN IF NOT EXISTS source_packet_ids JSONB NOT NULL DEFAULT '[]'`);
  await pool.query(`ALTER TABLE memory_candidate_queue ADD COLUMN IF NOT EXISTS promotion_ready BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE memory_candidate_queue ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`);

  await pool.query(`ALTER TABLE memory_candidate_queue ALTER COLUMN memory_id DROP NOT NULL`);

  await pool.query(
    `ALTER TABLE memory_candidate_queue DROP CONSTRAINT IF EXISTS memory_candidate_queue_candidate_type_check`,
  );
  await pool.query(
    `ALTER TABLE memory_candidate_queue ADD CONSTRAINT memory_candidate_queue_candidate_type_check
     CHECK (candidate_type IN (${typeList}))`,
  );

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_memory_candidate_queue_status
     ON memory_candidate_queue(status, candidate_type)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_memory_candidate_queue_memory
     ON memory_candidate_queue(memory_id)`,
  );
  // Drop old non-unique index if it exists (from pre-unified schema), then create unique
  await pool.query(`DROP INDEX IF EXISTS idx_memory_candidate_queue_dedup`);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_candidate_queue_dedup
     ON memory_candidate_queue(candidate_type, dedup_key)
     WHERE dedup_key IS NOT NULL AND status = 'pending'`,
  );

  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_candidate_queue_pending_unique
     ON memory_candidate_queue(candidate_type, memory_id)
     WHERE status = 'pending'`,
  );

  getLogger().info('Candidate queue schema initialized (unified)');
}

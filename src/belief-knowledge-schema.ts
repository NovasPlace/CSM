import type { DatabasePool } from './types.js';
import { getLogger } from './logger.js';

export async function initializeBeliefKnowledgeSchema(pool: DatabasePool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS belief_knowledge_store (
      id BIGSERIAL PRIMARY KEY,
      belief_kind TEXT NOT NULL CHECK (belief_kind IN ('preference', 'opinion', 'worldview')),
      subject TEXT NOT NULL,
      claim TEXT NOT NULL,
      stance TEXT NOT NULL DEFAULT 'neutral' CHECK (stance IN ('supports', 'opposes', 'neutral')),
      confidence DOUBLE PRECISION NOT NULL DEFAULT 0.3 CHECK (confidence BETWEEN 0 AND 1),
      uncertainty DOUBLE PRECISION NOT NULL DEFAULT 0.5 CHECK (uncertainty BETWEEN 0 AND 1),
      evidence_refs JSONB NOT NULL DEFAULT '[]',
      contradicted_count INTEGER NOT NULL DEFAULT 0,
      last_reinforced_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'promoted', 'rejected', 'stale')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (belief_kind, subject, claim)
    )
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_belief_knowledge_kind ON belief_knowledge_store(belief_kind)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_belief_knowledge_status ON belief_knowledge_store(status, belief_kind)');

  // Migration: REAL (float4) cannot store subnormal values produced by
  // exponential uncertainty decay (e.g. 0.5 * 0.9^1033 ≈ 6.56e-46).
  // Upgrade to double precision (float8) so valid belief-state math is preserved.
  await migrateBeliefColumnsToDoublePrecision(pool);

  getLogger().info('Belief knowledge schema initialized');
}

/**
 * Idempotent additive migration: upgrade confience/uncertainty from REAL (float4)
 * to DOUBLE PRECISION (float8). Guarded by information_schema so it only runs
 * when the columns are still REAL — avoids a full table rewrite on every startup
 * once already double precision. Never floors valid tiny values.
 */
async function migrateBeliefColumnsToDoublePrecision(pool: DatabasePool): Promise<void> {
  const res = await pool.query(
    `SELECT data_type FROM information_schema.columns
     WHERE table_name = 'belief_knowledge_store' AND column_name = 'confidence'`,
  );
  const dataType = (res.rows[0] as { data_type?: string } | undefined)?.data_type;
  if (dataType === 'real') {
    await pool.query(
      `ALTER TABLE belief_knowledge_store
         ALTER COLUMN confidence TYPE double precision,
         ALTER COLUMN uncertainty TYPE double precision`,
    );
    getLogger().info('Belief knowledge schema: upgraded confidence/uncertainty to double precision');
  }
}

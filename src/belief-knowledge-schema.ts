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
      confidence REAL NOT NULL DEFAULT 0.3 CHECK (confidence BETWEEN 0 AND 1),
      uncertainty REAL NOT NULL DEFAULT 0.5 CHECK (uncertainty BETWEEN 0 AND 1),
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

  getLogger().info('Belief knowledge schema initialized');
}
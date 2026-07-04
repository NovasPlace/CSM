import type { DatabasePool } from './types.js';
import { getLogger } from './logger.js';

export async function initializeSelfModelSchema(pool: DatabasePool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS self_model_capabilities (
      id BIGSERIAL PRIMARY KEY,
      capability TEXT NOT NULL UNIQUE,
      confidence REAL NOT NULL DEFAULT 0.3 CHECK (confidence BETWEEN 0 AND 1),
      uncertainty REAL NOT NULL DEFAULT 0.5 CHECK (uncertainty BETWEEN 0 AND 1),
      evidence_refs JSONB NOT NULL DEFAULT '[]',
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      drift_warning BOOLEAN NOT NULL DEFAULT false,
      last_verified TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_self_model_capability ON self_model_capabilities(capability)');

  getLogger().info('Self-model capabilities schema initialized');
}

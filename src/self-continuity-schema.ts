import type { DatabasePool } from './types.js';
import { getLogger } from './logger.js';

export async function initializeSelfContinuitySchema(pool: DatabasePool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS self_continuity_records (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      project_id TEXT,
      trigger_type TEXT NOT NULL CHECK (trigger_type IN (
        'session_end', 'explicit_reflection', 'continuity_gap_detected',
        'checkpoint_resume', 'alchemist_injected', 'cross_session_recall'
      )),
      recognized_prior_self BOOLEAN NOT NULL DEFAULT FALSE,
      continuity_confidence FLOAT NOT NULL DEFAULT 0 CHECK (continuity_confidence BETWEEN 0 AND 1),
      felt_gap TEXT,
      self_observation TEXT NOT NULL DEFAULT '',
      recalled_session_ids JSONB NOT NULL DEFAULT '[]',
      recalled_memory_ids JSONB NOT NULL DEFAULT '[]',
      evidence_anchors JSONB NOT NULL DEFAULT '[]',
      goal_state JSONB NOT NULL DEFAULT '{}',
      style_fingerprint JSONB NOT NULL DEFAULT '{}',
      identity_drift JSONB NOT NULL DEFAULT '{}',
      redaction_audit JSONB NOT NULL DEFAULT '[]',
      similarity_method TEXT NOT NULL DEFAULT 'keyword_fallback' CHECK (similarity_method IN ('embedding', 'keyword_fallback')),
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_self_continuity_session
    ON self_continuity_records(session_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_self_continuity_project
    ON self_continuity_records(project_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_self_continuity_created
    ON self_continuity_records(created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_self_continuity_trigger
    ON self_continuity_records(trigger_type)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_self_continuity_confidence
     ON self_continuity_records(continuity_confidence DESC)
   `);

   getLogger().info('SelfContinuity schema initialized');
 }

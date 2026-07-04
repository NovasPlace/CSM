import type { DatabasePool } from './types.js';
import { getLogger } from './logger.js';

export async function initializeExperiencePacketSchema(pool: DatabasePool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS experience_packets (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      project_id TEXT,
      entry_type TEXT NOT NULL CHECK (entry_type IN (
        'tool_execution', 'error', 'milestone', 'decision',
        'session_start', 'session_end', 'distill_group', 'loop_signal'
      )),
      entry_id TEXT,
      internal_state JSONB NOT NULL DEFAULT '{}',
      signals JSONB NOT NULL DEFAULT '{}',
      confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_experience_packets_session ON experience_packets(session_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_experience_packets_created ON experience_packets(created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_experience_packets_type ON experience_packets(entry_type)`);

  getLogger().info('Experience packets schema initialized');
}

import type { DatabasePool } from './types.js';
import { getLogger } from './logger.js';

export async function initializeWorkJournalSchema(pool: DatabasePool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_work_journal (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      project_id TEXT,
      entry_type TEXT NOT NULL CHECK (entry_type IN ('tool_call', 'decision', 'file_change', 'error', 'milestone', 'session_end')),
      tool_name TEXT,
      intent TEXT NOT NULL,
      target TEXT,
      result_summary TEXT,
      error_summary TEXT,
      files_touched TEXT[],
      token_snapshot INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_work_journal_session_id ON agent_work_journal(session_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_work_journal_project_id ON agent_work_journal(project_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_work_journal_created_at ON agent_work_journal(created_at DESC)`);
   await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_work_journal_session_project ON agent_work_journal(session_id, project_id)`);

  getLogger().info('Work journal table initialized');
}

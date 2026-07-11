import type { DatabasePool } from '../../types.js';

const WORK_JOURNAL_SQL = `
  CREATE TABLE IF NOT EXISTS agent_work_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    project_id TEXT,
    entry_type TEXT NOT NULL CHECK (entry_type IN (
      'tool_call', 'decision', 'file_change', 'error', 'milestone', 'session_end'
    )),
    tool_name TEXT,
    intent TEXT NOT NULL,
    target TEXT,
    result_summary TEXT,
    error_summary TEXT,
    files_touched TEXT NOT NULL DEFAULT '[]',
    token_snapshot INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`;

export async function initializeSqliteWorkJournal(pool: DatabasePool): Promise<void> {
  await pool.query(WORK_JOURNAL_SQL);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_agent_work_journal_session_id ON agent_work_journal(session_id)',
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_agent_work_journal_project_id ON agent_work_journal(project_id)',
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_agent_work_journal_created_at ON agent_work_journal(created_at DESC)',
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_agent_work_journal_session_project
     ON agent_work_journal(session_id, project_id)`,
  );
}

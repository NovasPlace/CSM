import type { DatabasePool } from '../../types.js';

const EVENTS_SQL = `
  CREATE TABLE IF NOT EXISTS memory_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`;

const RECALL_SQL = `
  CREATE TABLE IF NOT EXISTS memory_recall_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id INTEGER,
    session_id TEXT,
    project_id TEXT,
    query_hash TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('search', 'list', 'context_recall', 'graph', 'vector_only', 'text_only', 'text_fallback', 'empty_result')),
    rank INTEGER NOT NULL,
    score REAL,
    recalled_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`;

const PACKETS_SQL = `
  CREATE TABLE IF NOT EXISTS experience_packets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    project_id TEXT,
    entry_type TEXT NOT NULL CHECK (entry_type IN (
      'tool_execution', 'error', 'milestone', 'decision',
      'session_start', 'session_checkpoint', 'session_end', 'distill_group', 'loop_signal'
    )),
    entry_id TEXT,
    internal_state TEXT NOT NULL DEFAULT '{}',
    signals TEXT NOT NULL DEFAULT '{}',
    confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`;

export async function initializeSqliteEvents(pool: DatabasePool): Promise<void> {
  await pool.query(EVENTS_SQL);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_memory_events_channel ON memory_events(channel)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_memory_events_created ON memory_events(created_at DESC)');
  await pool.query(RECALL_SQL);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_memory_recall_events_memory ON memory_recall_events(memory_id, recalled_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_memory_recall_events_session ON memory_recall_events(session_id, recalled_at DESC)');
  await pool.query(PACKETS_SQL);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_experience_packets_session ON experience_packets(session_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_experience_packets_created ON experience_packets(created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_experience_packets_type ON experience_packets(entry_type)');
}

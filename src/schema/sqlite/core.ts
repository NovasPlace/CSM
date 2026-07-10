import type { DatabasePool } from '../../types.js';

const SESSIONS_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    workspace_id TEXT,
    directory TEXT,
    title TEXT,
    name TEXT,
    summary TEXT,
    turn_count INTEGER DEFAULT 0,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT
  )
`;

const PROJECTS_SQL = `
  CREATE TABLE IF NOT EXISTS project_scopes (
    project_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    directory TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_active_at TEXT NOT NULL DEFAULT (datetime('now')),
    memory_count INTEGER NOT NULL DEFAULT 0
  )
`;

const MEMORIES_SQL = `
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    project_id TEXT,
    memory_type TEXT NOT NULL CHECK (memory_type IN (
      'conversation', 'workspace', 'repo', 'preference',
      'lesson', 'episodic', 'procedural', 'concept', 'code', 'config', 'error',
      'self_continuity'
    )),
    content TEXT NOT NULL,
    embedding TEXT,
    importance REAL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
    emotion TEXT DEFAULT 'neutral' CHECK (emotion IN (
      'neutral', 'frustration', 'frustrated', 'success', 'curiosity', 'concern'
    )),
    confidence REAL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
    source TEXT DEFAULT 'manual',
    tags TEXT DEFAULT '[]',
    linked_memory_ids TEXT DEFAULT '[]',
    metadata TEXT DEFAULT '{}',
    access_count INTEGER NOT NULL DEFAULT 0,
    turn_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_accessed_at TEXT,
    archived_at TEXT,
    archive_reason TEXT,
    archive_batch_id TEXT,
    archive_source TEXT,
    archive_note TEXT,
    superseded_by INTEGER,
    superseded_at TEXT
  )
`;

export async function initializeSqliteCore(pool: DatabasePool): Promise<void> {
  await pool.query(SESSIONS_SQL);
  await pool.query(PROJECTS_SQL);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_project_scopes_directory ON project_scopes(directory)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_project_scopes_last_active ON project_scopes(last_active_at DESC)');
  await pool.query(MEMORIES_SQL);
}

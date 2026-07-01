import type { DatabasePool } from '../../types.js';

export async function initializeMinimalSqliteSchema(pool: DatabasePool): Promise<void> {
  await pool.query(`
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
  `);

  await pool.query(`
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
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      embedding TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (memory_id, chunk_index)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_merges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canonical_id INTEGER NOT NULL,
      duplicate_ids TEXT NOT NULL,
      reason TEXT NOT NULL,
      normalized_hash TEXT NOT NULL,
      duplicate_count INTEGER NOT NULL,
      merged_at TEXT NOT NULL DEFAULT (datetime('now')),
      merged_by TEXT NOT NULL DEFAULT 'merge-tool',
      dry_run BOOLEAN NOT NULL DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_quality_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id INTEGER NOT NULL UNIQUE,
      memory_type TEXT,
      score REAL NOT NULL CHECK (score >= 0 AND score <= 1),
      band TEXT,
      features TEXT DEFAULT '{}',
      scoring_version TEXT,
      scored_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_memories_session_id ON memories(session_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_memories_superseded_by ON memories(superseded_by) WHERE superseded_by IS NOT NULL');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_memory_merges_canonical_id ON memory_merges(canonical_id)');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_quality_scores_memory_id ON memory_quality_scores(memory_id)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      session_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_memory_events_channel ON memory_events(channel)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_memory_events_created ON memory_events(created_at DESC)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_recall_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id INTEGER NOT NULL,
      session_id TEXT,
      project_id TEXT,
      query_hash TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('search', 'list', 'context_recall')),
      rank INTEGER NOT NULL,
      score REAL,
      recalled_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_memory_recall_events_memory ON memory_recall_events(memory_id, recalled_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_memory_recall_events_session ON memory_recall_events(session_id, recalled_at DESC)');
}

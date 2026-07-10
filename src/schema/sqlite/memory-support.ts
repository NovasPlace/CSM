import type { DatabasePool } from '../../types.js';

const CHUNKS_SQL = `
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
`;

const MERGES_SQL = `
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
`;

const LINKS_SQL = `
  CREATE TABLE IF NOT EXISTS memory_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    target_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    link_type TEXT NOT NULL CHECK (link_type IN ('shared_entity', 'causal', 'temporal', 'reference')),
    shared_entities TEXT NOT NULL DEFAULT '[]',
    strength REAL NOT NULL DEFAULT 0.5,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_id, target_id, link_type)
  )
`;

const QUALITY_SQL = `
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
`;

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_memories_session_id ON memories(session_id)',
  'CREATE INDEX IF NOT EXISTS idx_memories_superseded_by ON memories(superseded_by) WHERE superseded_by IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id)',
  'CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type)',
  'CREATE INDEX IF NOT EXISTS idx_memories_importance_created ON memories(importance DESC, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_memory_merges_canonical_id ON memory_merges(canonical_id)',
  'CREATE INDEX IF NOT EXISTS idx_memory_links_source ON memory_links(source_id)',
  'CREATE INDEX IF NOT EXISTS idx_memory_links_target ON memory_links(target_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_quality_scores_memory_id ON memory_quality_scores(memory_id)',
];

export async function initializeSqliteMemorySupport(pool: DatabasePool): Promise<void> {
  await pool.query(CHUNKS_SQL);
  await pool.query(MERGES_SQL);
  await pool.query(LINKS_SQL);
  await pool.query(QUALITY_SQL);
  for (const sql of INDEXES) await pool.query(sql);
}

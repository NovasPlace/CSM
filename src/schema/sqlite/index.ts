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
  await pool.query('CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_memories_importance_created ON memories(importance DESC, created_at DESC)');
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
      memory_id INTEGER,
      session_id TEXT,
      project_id TEXT,
      query_hash TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('search', 'list', 'context_recall', 'graph', 'vector_only', 'text_only', 'text_fallback', 'empty_result')),
      rank INTEGER NOT NULL,
      score REAL,
      recalled_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_memory_recall_events_memory ON memory_recall_events(memory_id, recalled_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_memory_recall_events_session ON memory_recall_events(session_id, recalled_at DESC)');

  await pool.query(`
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
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_experience_packets_session ON experience_packets(session_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_experience_packets_created ON experience_packets(created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_experience_packets_type ON experience_packets(entry_type)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_candidate_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_type TEXT NOT NULL CHECK (candidate_type IN (
        'prune', 'promote_to_lesson', 'merge', 'stale_preference', 'refresh_summary',
        'candidate_belief', 'candidate_preference', 'candidate_worldview', 'candidate_drift_warning',
        'candidate_opinion'
      )),
      memory_id INTEGER REFERENCES memories(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
      source_signals TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'reviewed', 'dismissed', 'applied'
      )),
      dedup_key TEXT,
      event_count INTEGER NOT NULL DEFAULT 1,
      reinforcement_count INTEGER NOT NULL DEFAULT 0,
      contradicted_count INTEGER NOT NULL DEFAULT 0,
      last_reinforced_at TEXT,
      source_packet_ids TEXT NOT NULL DEFAULT '[]',
      promotion_ready INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    )
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_memory_candidate_queue_status ON memory_candidate_queue(status, candidate_type)',
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_memory_candidate_queue_memory ON memory_candidate_queue(memory_id)',
  );
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_candidate_queue_pending_unique ON memory_candidate_queue(candidate_type, memory_id) WHERE status = \'pending\'',
  );
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_candidate_queue_dedup ON memory_candidate_queue(candidate_type, dedup_key) WHERE dedup_key IS NOT NULL AND status = \'pending\'',
  );

  try { await pool.query('ALTER TABLE memory_candidate_queue ADD COLUMN dedup_key TEXT'); } catch { /* exists */ }
  try { await pool.query('ALTER TABLE memory_candidate_queue ADD COLUMN event_count INTEGER NOT NULL DEFAULT 1'); } catch { /* exists */ }
  try { await pool.query('ALTER TABLE memory_candidate_queue ADD COLUMN reinforcement_count INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
  try { await pool.query('ALTER TABLE memory_candidate_queue ADD COLUMN contradicted_count INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
  try { await pool.query('ALTER TABLE memory_candidate_queue ADD COLUMN last_reinforced_at TEXT'); } catch { /* exists */ }
  try { await pool.query('ALTER TABLE memory_candidate_queue ADD COLUMN source_packet_ids TEXT NOT NULL DEFAULT \'[]\''); } catch { /* exists */ }
  try { await pool.query('ALTER TABLE memory_candidate_queue ADD COLUMN promotion_ready INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
  try { await pool.query('ALTER TABLE memory_candidate_queue ADD COLUMN updated_at TEXT'); } catch { /* exists */ }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS self_model_capabilities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      capability TEXT NOT NULL UNIQUE,
      confidence REAL NOT NULL DEFAULT 0.3 CHECK (confidence BETWEEN 0 AND 1),
      uncertainty REAL NOT NULL DEFAULT 0.5 CHECK (uncertainty BETWEEN 0 AND 1),
      evidence_refs TEXT NOT NULL DEFAULT '[]',
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      drift_warning INTEGER NOT NULL DEFAULT 0,
      last_verified TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_self_model_capability ON self_model_capabilities(capability)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS belief_knowledge_store (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      belief_kind TEXT NOT NULL CHECK (belief_kind IN ('preference', 'opinion', 'worldview')),
      subject TEXT NOT NULL,
      claim TEXT NOT NULL,
      stance TEXT NOT NULL DEFAULT 'neutral' CHECK (stance IN ('supports', 'opposes', 'neutral')),
      confidence REAL NOT NULL DEFAULT 0.3 CHECK (confidence BETWEEN 0 AND 1),
      uncertainty REAL NOT NULL DEFAULT 0.5 CHECK (uncertainty BETWEEN 0 AND 1),
      evidence_refs TEXT NOT NULL DEFAULT '[]',
      contradicted_count INTEGER NOT NULL DEFAULT 0,
      last_reinforced_at TEXT,
      status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'promoted', 'rejected', 'stale')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (belief_kind, subject, claim)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_belief_knowledge_kind ON belief_knowledge_store(belief_kind)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_belief_knowledge_status ON belief_knowledge_store(status, belief_kind)');
}

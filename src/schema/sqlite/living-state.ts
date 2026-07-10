import type { DatabasePool } from '../../types.js';

const CANDIDATES_SQL = `
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
`;

const SELF_MODEL_SQL = `
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
`;

const BELIEFS_SQL = `
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
`;

const CANDIDATE_COLUMNS = [
  ['dedup_key', 'dedup_key TEXT'],
  ['event_count', 'event_count INTEGER NOT NULL DEFAULT 1'],
  ['reinforcement_count', 'reinforcement_count INTEGER NOT NULL DEFAULT 0'],
  ['contradicted_count', 'contradicted_count INTEGER NOT NULL DEFAULT 0'],
  ['last_reinforced_at', 'last_reinforced_at TEXT'],
  ['source_packet_ids', "source_packet_ids TEXT NOT NULL DEFAULT '[]'"],
  ['promotion_ready', 'promotion_ready INTEGER NOT NULL DEFAULT 0'],
  ['updated_at', 'updated_at TEXT'],
] as const;

export async function initializeSqliteLivingState(pool: DatabasePool): Promise<void> {
  await pool.query(CANDIDATES_SQL);
  await upgradeCandidateColumns(pool);
  await createCandidateIndexes(pool);
  await pool.query(SELF_MODEL_SQL);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_self_model_capability ON self_model_capabilities(capability)');
  await pool.query(BELIEFS_SQL);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_belief_knowledge_kind ON belief_knowledge_store(belief_kind)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_belief_knowledge_status ON belief_knowledge_store(status, belief_kind)');
}

async function upgradeCandidateColumns(pool: DatabasePool): Promise<void> {
  const result = await pool.query('PRAGMA table_info(memory_candidate_queue)');
  const existing = new Set(
    (result.rows as Array<{ name?: unknown }>)
      .map((row) => row.name)
      .filter((name): name is string => typeof name === 'string'),
  );
  for (const [name, definition] of CANDIDATE_COLUMNS) {
    if (!existing.has(name)) {
      await pool.query(`ALTER TABLE memory_candidate_queue ADD COLUMN ${definition}`);
    }
  }
}

async function createCandidateIndexes(pool: DatabasePool): Promise<void> {
  await pool.query('CREATE INDEX IF NOT EXISTS idx_memory_candidate_queue_status ON memory_candidate_queue(status, candidate_type)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_memory_candidate_queue_memory ON memory_candidate_queue(memory_id)');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_candidate_queue_pending_unique ON memory_candidate_queue(candidate_type, memory_id) WHERE status = \'pending\'');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_candidate_queue_dedup ON memory_candidate_queue(candidate_type, dedup_key) WHERE dedup_key IS NOT NULL AND status = \'pending\'');
}

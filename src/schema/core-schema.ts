import type { DatabasePool } from '../types.js';

export async function initializeCoreSchema(pool: DatabasePool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS distilled_summaries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      groups JSONB NOT NULL DEFAULT '[]',
      compressed TEXT NOT NULL,
      total_calls_summarized INT NOT NULL DEFAULT 0,
      built_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_distilled_summaries_session ON distilled_summaries(session_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_distilled_summaries_built ON distilled_summaries(built_at DESC)`);

  // Defense-in-depth: prevent duplicate distilled summaries (e.g. from multiple
  // plugin instances). Two summaries with identical compressed text in the same
  // session are collapsed via ON CONFLICT DO NOTHING on this hash index.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_distilled_summaries_dedup
    ON distilled_summaries (session_id, md5(compressed))
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS compaction_metrics (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      total_tool_parts INT NOT NULL DEFAULT 0,
      compacted_parts INT NOT NULL DEFAULT 0,
      skipped_parts INT NOT NULL DEFAULT 0,
      before_chars INT NOT NULL DEFAULT 0,
      after_chars INT NOT NULL DEFAULT 0,
      before_tokens INT NOT NULL DEFAULT 0,
      after_tokens INT NOT NULL DEFAULT 0,
      tokens_saved INT NOT NULL DEFAULT 0,
      saved_percent INT NOT NULL DEFAULT 0,
      semantic_signal_count_preserved INT NOT NULL DEFAULT 0,
      context_brief_chars INT NOT NULL DEFAULT 0,
      discard_marker_present BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'compressed' CHECK (status IN ('compressed', 'skipped_under_budget', 'failed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`ALTER TABLE compaction_metrics ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'compressed' CHECK (status IN ('compressed', 'skipped_under_budget', 'failed'))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_compaction_metrics_session ON compaction_metrics(session_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_compaction_metrics_created ON compaction_metrics(created_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_candidates (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      proposed_type TEXT NOT NULL CHECK (proposed_type IN (
        'conversation', 'workspace', 'repo', 'preference', 'lesson', 'episodic', 'procedural'
      )),
      content TEXT NOT NULL,
      importance FLOAT DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
      emotion TEXT DEFAULT 'neutral' CHECK (emotion IN (
          'neutral', 'frustration', 'frustrated', 'success', 'curiosity', 'concern'
        )),
      confidence FLOAT DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
      tags TEXT[] DEFAULT '{}',
      metadata JSONB NOT NULL DEFAULT '{}',
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'auto-approved', 'archived')),
      source TEXT NOT NULL CHECK (source IN ('extractor', 'manual')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_at TIMESTAMPTZ,
      reviewed_by TEXT
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_candidates_session ON memory_candidates(session_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_candidates_project ON memory_candidates(project_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_candidates_status ON memory_candidates(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_candidates_created ON memory_candidates(created_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_scopes (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      directory TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      memory_count INTEGER DEFAULT 0
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_project_scopes_directory ON project_scopes(directory)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_project_scopes_last_active ON project_scopes(last_active_at DESC)`);
}

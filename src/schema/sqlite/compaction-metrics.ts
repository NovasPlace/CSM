import type { DatabasePool } from '../../types.js';

export const COMPACTION_METRICS_COLUMNS = [
  'id',
  'session_id',
  'total_tool_parts',
  'compacted_parts',
  'skipped_parts',
  'before_chars',
  'after_chars',
  'before_tokens',
  'after_tokens',
  'tokens_saved',
  'saved_percent',
  'semantic_signal_count_preserved',
  'context_brief_chars',
  'discard_marker_present',
  'status',
  'created_at',
] as const;

const COMPACTION_METRICS_SQL = `
  CREATE TABLE IF NOT EXISTS compaction_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    total_tool_parts INTEGER NOT NULL DEFAULT 0,
    compacted_parts INTEGER NOT NULL DEFAULT 0,
    skipped_parts INTEGER NOT NULL DEFAULT 0,
    before_chars INTEGER NOT NULL DEFAULT 0,
    after_chars INTEGER NOT NULL DEFAULT 0,
    before_tokens INTEGER NOT NULL DEFAULT 0,
    after_tokens INTEGER NOT NULL DEFAULT 0,
    tokens_saved INTEGER NOT NULL DEFAULT 0,
    saved_percent INTEGER NOT NULL DEFAULT 0,
    semantic_signal_count_preserved INTEGER NOT NULL DEFAULT 0,
    context_brief_chars INTEGER NOT NULL DEFAULT 0,
    discard_marker_present INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'compressed'
      CHECK (status IN ('compressed', 'skipped_under_budget', 'failed')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )
`;

export async function initializeCompactionMetricsSchema(pool: DatabasePool): Promise<void> {
  await pool.query(COMPACTION_METRICS_SQL);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_compaction_metrics_session ON compaction_metrics(session_id)',
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_compaction_metrics_created ON compaction_metrics(created_at DESC)',
  );
}

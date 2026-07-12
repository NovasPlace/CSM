import type { DatabasePool } from '../../types.js';
import {
  COMPACTION_METRICS_COLUMNS,
  initializeCompactionMetricsSchema,
} from './compaction-metrics.js';

interface PragmaRow {
  name: string;
}

const COLUMN_DEFAULTS: Record<string, string> = {
  total_tool_parts: '0',
  compacted_parts: '0',
  skipped_parts: '0',
  before_chars: '0',
  after_chars: '0',
  before_tokens: '0',
  after_tokens: '0',
  tokens_saved: '0',
  saved_percent: '0',
  semantic_signal_count_preserved: '0',
  context_brief_chars: '0',
  discard_marker_present: '0',
  status: `'compressed'`,
  created_at: `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
};

export async function migrateCompactionMetricsSqlite(pool: DatabasePool): Promise<void> {
  const tableInfo = await pool.query('PRAGMA table_info(compaction_metrics)');
  const existingColumns = (tableInfo.rows as PragmaRow[]).map((r) => r.name);

  if (existingColumns.length === 0) {
    await initializeCompactionMetricsSchema(pool);
    return;
  }

  const expected: readonly string[] = COMPACTION_METRICS_COLUMNS.filter((c) => c !== 'id');
  const missing = expected.filter((c) => !existingColumns.includes(c));

  if (missing.length === 0) {
    return;
  }

  const intersect = existingColumns.filter((c) => expected.includes(c) || c === 'id');
  const missingWithDefaults = expected.filter((c) => !intersect.includes(c));
  const colList = intersect.join(', ');
  const defaultCols = missingWithDefaults.join(', ');

  await pool.query(`
    CREATE TABLE compaction_metrics_canonical (
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
  `);

  const selectExpr = colList
    + (defaultCols.length > 0 ? `, ${missingWithDefaults.map((c) => COLUMN_DEFAULTS[c] ?? '0').join(', ')}` : '');

  await pool.query(
    `INSERT INTO compaction_metrics_canonical (${colList}${defaultCols.length > 0 ? ', ' + defaultCols : ''}) SELECT ${selectExpr} FROM compaction_metrics`,
  );

  await pool.query('DROP TABLE compaction_metrics');
  await pool.query('ALTER TABLE compaction_metrics_canonical RENAME TO compaction_metrics');

  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_compaction_metrics_session ON compaction_metrics(session_id)',
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_compaction_metrics_created ON compaction_metrics(created_at DESC)',
  );
}

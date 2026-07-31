import type { DatabasePool } from '../types.js';
import { dialectFromPool } from '../db/query-dialect.js';

export const COMPACTION_ATTRIBUTION_COLUMNS = [
  'project_id',
  'client_kind',
  'runtime_kind',
  'eligible_parts',
  'persisted_parts',
  'failure_stage',
  'failure_code',
  'failure_message',
] as const;

const COLUMN_DEFINITIONS: Readonly<Record<(typeof COMPACTION_ATTRIBUTION_COLUMNS)[number], string>> = {
  project_id: 'TEXT',
  client_kind: "TEXT NOT NULL DEFAULT 'unknown'",
  runtime_kind: "TEXT NOT NULL DEFAULT 'unknown'",
  eligible_parts: 'INTEGER NOT NULL DEFAULT 0',
  persisted_parts: 'INTEGER NOT NULL DEFAULT 0',
  failure_stage: 'TEXT',
  failure_code: 'TEXT',
  failure_message: 'TEXT',
};

interface ColumnRow {
  name?: string;
  column_name?: string;
}

/**
 * Adds database-wide attribution and actionable failure diagnostics without
 * rewriting historical compaction rows. Historical project ids are recovered
 * from sessions when possible; other provenance remains explicitly unknown.
 */
export async function migrateCompactionAttribution(pool: DatabasePool): Promise<void> {
  const dialect = dialectFromPool(pool);
  const columns = await existingColumns(pool, dialect);

  for (const column of COMPACTION_ATTRIBUTION_COLUMNS) {
    if (columns.has(column)) continue;
    await pool.query(
      `ALTER TABLE compaction_metrics ADD COLUMN ${column} ${COLUMN_DEFINITIONS[column]}`,
    );
  }

  await pool.query(`
    UPDATE compaction_metrics
    SET project_id = (
      SELECT sessions.project_id
      FROM sessions
      WHERE sessions.id = compaction_metrics.session_id
    )
    WHERE project_id IS NULL
      AND EXISTS (
        SELECT 1 FROM sessions WHERE sessions.id = compaction_metrics.session_id
      )
  `);

  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_compaction_metrics_project ON compaction_metrics(project_id)',
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_compaction_metrics_runtime ON compaction_metrics(client_kind, runtime_kind)',
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_compaction_metrics_failure ON compaction_metrics(failure_stage, failure_code)',
  );
}

async function existingColumns(pool: DatabasePool, dialect: 'pg' | 'sqlite'): Promise<Set<string>> {
  const result = dialect === 'sqlite'
    ? await pool.query('PRAGMA table_info(compaction_metrics)')
    : await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'compaction_metrics'`,
    );
  return new Set((result.rows as ColumnRow[])
    .map((row) => row.name ?? row.column_name)
    .filter((name): name is string => Boolean(name)));
}

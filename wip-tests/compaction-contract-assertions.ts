import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { DatabasePool } from '../dist/types.js';
import type { CompactionMetricInput } from '../dist/compaction-metric-writer.js';
import { writeCompactionMetric } from '../dist/compaction-metric-writer.js';
import { auditCompactionTelemetry } from '../dist/compaction-telemetry-audit.js';

type ContractCase = { name: string; run: (pool: DatabasePool) => Promise<void> };

const INSIDE = new Date(Date.now() - 2 * 3_600_000).toISOString();
const OUTSIDE = new Date(Date.now() - 48 * 3_600_000).toISOString();
export const CONTRACT_SESSION_ID = 'contract-test';

function metric(overrides: Partial<CompactionMetricInput> = {}): CompactionMetricInput {
  return {
    sessionId: CONTRACT_SESSION_ID, totalToolParts: 10, compactedParts: 5, skippedParts: 2,
    beforeChars: 5000, afterChars: 2500, beforeTokens: 1500, afterTokens: 800,
    tokensSaved: 700, savedPercent: 46, semanticSignalCountPreserved: 12,
    contextBriefChars: 0, discardMarkerPresent: 0, status: 'compressed', createdAt: INSIDE,
    ...overrides,
  };
}

async function clear(pool: DatabasePool): Promise<void> {
  await pool.query('DELETE FROM compaction_metrics');
}

async function assertWriterRoundTrip(pool: DatabasePool): Promise<void> {
  await clear(pool);
  await writeCompactionMetric(pool, metric());
  const row = (await pool.query('SELECT * FROM compaction_metrics')).rows[0] as Record<string, unknown>;
  for (const column of ['id', 'session_id', 'total_tool_parts', 'compacted_parts', 'skipped_parts', 'before_chars', 'after_chars', 'before_tokens', 'after_tokens', 'tokens_saved', 'saved_percent', 'semantic_signal_count_preserved', 'context_brief_chars', 'discard_marker_present', 'status', 'created_at']) assert.ok(column in row, `missing column: ${column}`);
  assert.equal(row.tokens_saved, 700);
  const timestamp = typeof row.created_at === 'string' ? row.created_at : new Date(row.created_at as Date).toISOString();
  assert.equal(timestamp, INSIDE);
}

async function assertStatuses(pool: DatabasePool): Promise<void> {
  await clear(pool);
  await writeCompactionMetric(pool, metric({ status: 'skipped_under_budget', compactedParts: 0, tokensSaved: 0, savedPercent: 0 }));
  await writeCompactionMetric(pool, metric({ status: 'failed', compactedParts: 0, beforeChars: 0, afterChars: 0, beforeTokens: 0, afterTokens: 0, tokensSaved: 0, savedPercent: 0, semanticSignalCountPreserved: 0 }));
  const rows = await pool.query('SELECT status FROM compaction_metrics ORDER BY id');
  assert.deepEqual(rows.rows.map((row) => (row as { status: string }).status), ['skipped_under_budget', 'failed']);
}

async function assertCleanAudit(pool: DatabasePool): Promise<void> {
  await clear(pool);
  await writeCompactionMetric(pool, metric());
  const audit = await auditCompactionTelemetry(pool);
  assert.equal(audit.available, true);
  if (audit.available) assert.equal(audit.passed, true);
}

async function assertDuplicateDetection(pool: DatabasePool): Promise<void> {
  await clear(pool);
  await writeCompactionMetric(pool, metric());
  await writeCompactionMetric(pool, metric());
  const audit = await auditCompactionTelemetry(pool);
  assert.ok(audit.available && audit.result.duplicateIds.length > 0);
}

async function assertNegativeDetection(pool: DatabasePool): Promise<void> {
  await clear(pool);
  await writeCompactionMetric(pool, metric({ tokensSaved: -50 }));
  const audit = await auditCompactionTelemetry(pool);
  assert.ok(audit.available && audit.result.negativeValues.length > 0);
}

async function assertMathDetection(pool: DatabasePool): Promise<void> {
  await clear(pool);
  await writeCompactionMetric(pool, metric({ tokensSaved: 999 }));
  const audit = await auditCompactionTelemetry(pool);
  assert.ok(audit.available && audit.result.mathErrors.length > 0);
}

async function assertTimeBoundary(pool: DatabasePool): Promise<void> {
  await clear(pool);
  await writeCompactionMetric(pool, metric({ createdAt: INSIDE }));
  await writeCompactionMetric(pool, metric({ createdAt: OUTSIDE }));
  const result = await pool.query('SELECT COUNT(*) AS n FROM compaction_metrics WHERE created_at > $1', [new Date(Date.now() - 24 * 3_600_000).toISOString()]);
  assert.equal(Number((result.rows[0] as { n: string | number }).n), 1);
}

async function assertMissingTable(pool: DatabasePool): Promise<void> {
  await pool.query('DROP TABLE compaction_metrics');
  const audit = await auditCompactionTelemetry(pool);
  assert.deepEqual(audit, { available: false, reason: 'table_missing', passed: null });
}

async function assertIncompleteSchema(pool: DatabasePool, sqlite: boolean): Promise<void> {
  const id = sqlite ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'SERIAL PRIMARY KEY';
  await pool.query(`CREATE TABLE compaction_metrics (id ${id}, session_id TEXT NOT NULL, status TEXT NOT NULL, created_at ${sqlite ? 'TEXT' : 'TIMESTAMPTZ'})`);
  const audit = await auditCompactionTelemetry(pool);
  assert.deepEqual(audit, { available: false, reason: 'schema_incomplete', passed: null });
}

export function registerContractAssertions(getPool: () => DatabasePool, sqlite: boolean): void {
  const cases: ContractCase[] = [
    { name: 'persists all audit columns and the supplied timestamp', run: assertWriterRoundTrip },
    { name: 'persists all three telemetry statuses', run: assertStatuses },
    { name: 'passes a clean audit', run: assertCleanAudit },
    { name: 'detects duplicate rows through window functions', run: assertDuplicateDetection },
    { name: 'detects negative token savings', run: assertNegativeDetection },
    { name: 'detects incorrect token-saving math', run: assertMathDetection },
    { name: 'uses the same 24-hour cutoff on both backends', run: assertTimeBoundary },
    { name: 'reports a missing table without executing the audit', run: assertMissingTable },
    { name: 'reports incomplete schema without executing the audit', run: (pool) => assertIncompleteSchema(pool, sqlite) },
  ];
  for (const testCase of cases) it(testCase.name, () => testCase.run(getPool()));
}

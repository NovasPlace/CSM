import type { DatabasePool } from './types.js';
import { dialectFromPool } from './db/query-dialect.js';

export type AuditAvailability =
  | {
      available: true;
      passed: boolean;
      summary: string;
      result: AuditResult;
    }
  | {
      available: false;
      reason: 'table_missing' | 'schema_incomplete' | 'query_unsupported';
      passed: null;
    };

export interface AuditResult {
  totalRows: number;
  statusBreakdown: {
    compressed: number;
    skipped_under_budget: number;
    failed: number;
  };
  duplicateIds: number[];
  negativeValues: AuditAnomaly[];
  mathErrors: AuditAnomaly[];
  zeroBeforeOrAfter: AuditAnomaly[];
  savedExceedsBefore: AuditAnomaly[];
  afterExceedsBefore: AuditAnomaly[];
  recomputedTotals: {
    totalBeforeTokens: number;
    totalAfterTokens: number;
    totalTokensSaved: number;
    totalCompactions: number;
    avgTokensSavedPerCompaction: number;
    overallReductionPercent: number;
  };
  storedTotals: {
    totalBeforeTokens: number;
    totalAfterTokens: number;
    totalTokensSaved: number;
  };
  totalsMatch: boolean;
  sessionBreakdown: SessionBreakdown[];
  passed: boolean;
  summary: string;
}

export interface AuditAnomaly {
  id: number;
  sessionId: string;
  field: string;
  expected: string;
  actual: string;
}

export interface SessionBreakdown {
  sessionId: string;
  compactionCount: number;
  tokensSaved: number;
  beforeTokens: number;
  afterTokens: number;
  firstCompaction: string;
  lastCompaction: string;
}

// --- Typed DB row DTOs (Phase L4-B) ---

interface NegativeAnomalyRow {
  id: number;
  session_id: string;
  detail: string;
}

interface MathErrorRow {
  id: number;
  session_id: string;
  before_tokens: number;
  after_tokens: number;
  tokens_saved: number;
  recomputed_saved: number;
}

interface ZeroAnomalyRow {
  id: number;
  session_id: string;
  before_tokens: number;
  after_tokens: number;
}

interface SavedExceedsRow {
  id: number;
  session_id: string;
  before_tokens: number;
  tokens_saved: number;
}

interface IdRow {
  id: number;
}

interface CountRow {
  cnt: string | number;
}

interface TotalsRow {
  total_before: string | number;
  total_after: string | number;
  total_saved: string | number;
}

interface SessionBreakdownRow {
  session_id: string;
  count: string | number;
  saved: string | number;
  before: string | number;
  after: string | number;
  first: string;
  last: string;
}

export async function auditCompactionTelemetry(pool: DatabasePool): Promise<AuditAvailability> {
  const dialect = dialectFromPool(pool);

  // 1. Table existence precheck
  const tableExistsQuery = dialect === 'sqlite'
    ? "SELECT name FROM sqlite_master WHERE type='table' AND name='compaction_metrics'"
    : "SELECT to_regclass('compaction_metrics') AS name";
  const tableResult = await pool.query(tableExistsQuery);
  const tableRow = tableResult.rows[0] as { name: string | null } | undefined;
  if (!tableRow || !tableRow.name) {
    return { available: false, reason: 'table_missing', passed: null };
  }

  // 2. Schema-completeness check (all 15 non-id columns must exist)
  const schemaQuery = dialect === 'sqlite'
    ? 'PRAGMA table_info(compaction_metrics)'
    : `SELECT column_name FROM information_schema.columns WHERE table_name = 'compaction_metrics'`;
  const schemaResult = await pool.query(schemaQuery);
  const existingColumns = dialect === 'sqlite'
    ? (schemaResult.rows as { name: string }[]).map((r) => r.name)
    : (schemaResult.rows as { column_name: string }[]).map((r) => r.column_name);
  const requiredColumns = [
    'session_id', 'total_tool_parts', 'compacted_parts', 'skipped_parts',
    'before_chars', 'after_chars', 'before_tokens', 'after_tokens',
    'tokens_saved', 'saved_percent', 'semantic_signal_count_preserved',
    'context_brief_chars', 'discard_marker_present', 'status', 'created_at',
  ];
  const missingColumns = requiredColumns.filter((c) => !existingColumns.includes(c));
  if (missingColumns.length > 0) {
    return { available: false, reason: 'schema_incomplete', passed: null };
  }

  // 3. Window-function execution probe (feature detection, not version string)
  try {
    await pool.query('SELECT ROW_NUMBER() OVER (ORDER BY value) AS rn FROM (SELECT 1 AS value)');
  } catch {
    return { available: false, reason: 'query_unsupported', passed: null };
  }

  // 4. Run the actual audit logic
  const result = await runAuditLogic(pool);
  return {
    available: true,
    passed: result.passed,
    summary: result.summary,
    result,
  };
}

async function runAuditLogic(pool: DatabasePool): Promise<AuditResult> {
  const anomalies_neg = await pool.query(`
    SELECT id, session_id,
      'before_tokens=' || before_tokens || ' after_tokens=' || after_tokens || ' tokens_saved=' || tokens_saved as detail
    FROM compaction_metrics
    WHERE before_tokens < 0 OR after_tokens < 0 OR tokens_saved < 0
  `);

  const negativeValues: AuditAnomaly[] = [];
  for (const row of anomalies_neg.rows as NegativeAnomalyRow[]) {
    negativeValues.push({
      id: row.id,
      sessionId: row.session_id,
      field: 'negative_value',
      expected: '>= 0',
      actual: row.detail,
    });
  }

  const anomalies_math = await pool.query(`
    SELECT id, session_id,
      before_tokens, after_tokens, tokens_saved,
      (before_tokens - after_tokens) as recomputed_saved
    FROM compaction_metrics
    WHERE tokens_saved != (before_tokens - after_tokens)
  `);

  const mathErrors: AuditAnomaly[] = [];
  for (const row of anomalies_math.rows as MathErrorRow[]) {
    mathErrors.push({
      id: row.id,
      sessionId: row.session_id,
      field: 'tokens_saved',
      expected: `${row.before_tokens} - ${row.after_tokens} = ${row.recomputed_saved}`,
      actual: String(row.tokens_saved),
    });
  }

  const anomalies_zero = await pool.query(`
    SELECT id, session_id, before_tokens, after_tokens
    FROM compaction_metrics
    WHERE before_tokens = 0 OR after_tokens = 0
  `);

  const zeroBeforeOrAfter: AuditAnomaly[] = [];
  for (const row of anomalies_zero.rows as ZeroAnomalyRow[]) {
    const field = row.before_tokens === 0 ? 'before_tokens' : 'after_tokens';
    zeroBeforeOrAfter.push({
      id: row.id,
      sessionId: row.session_id,
      field,
      expected: '> 0',
      actual: '0',
    });
  }

  const anomalies_exceed = await pool.query(`
    SELECT id, session_id, before_tokens, after_tokens, tokens_saved
    FROM compaction_metrics
    WHERE tokens_saved > before_tokens
  `);

  const savedExceedsBefore: AuditAnomaly[] = [];
  for (const row of anomalies_exceed.rows as SavedExceedsRow[]) {
    savedExceedsBefore.push({
      id: row.id,
      sessionId: row.session_id,
      field: 'tokens_saved > before_tokens',
      expected: `tokens_saved <= ${row.before_tokens}`,
      actual: String(row.tokens_saved),
    });
  }

  const anomalies_after_exceed = await pool.query(`
    SELECT id, session_id, before_tokens, after_tokens
    FROM compaction_metrics
    WHERE after_tokens > before_tokens
  `);

  const afterExceedsBefore: AuditAnomaly[] = [];
  for (const row of anomalies_after_exceed.rows as Array<{ id: number; session_id: string; before_tokens: number; after_tokens: number }>) {
    afterExceedsBefore.push({
      id: row.id,
      sessionId: row.session_id,
      field: 'after_tokens > before_tokens',
      expected: `after_tokens <= ${row.before_tokens}`,
      actual: `after_tokens=${row.after_tokens} (expansion by ${row.after_tokens - row.before_tokens})`,
    });
  }

  const dedupCheck = await pool.query(`
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY session_id, before_tokens, after_tokens, tokens_saved, created_at) as rn
      FROM compaction_metrics
    ) sub WHERE rn > 1
  `);
  const duplicateIds = (dedupCheck.rows as IdRow[]).map((r) => Number(r.id));

  const countResult = await pool.query('SELECT COUNT(*) as cnt FROM compaction_metrics');
  const totalRows = parseInt(String((countResult.rows[0] as CountRow).cnt), 10);

  const statusResult = await pool.query(`
    SELECT status, COUNT(*) as cnt FROM compaction_metrics GROUP BY status
  `);
  const statusBreakdown = { compressed: 0, skipped_under_budget: 0, failed: 0 };
  for (const row of statusResult.rows as Array<{ status: string; cnt: string }>) {
    if (row.status in statusBreakdown) {
      statusBreakdown[row.status as keyof typeof statusBreakdown] = parseInt(row.cnt, 10);
    }
  }

  const storedResult = await pool.query(`
    SELECT
      SUM(before_tokens) as total_before,
      SUM(after_tokens) as total_after,
      SUM(tokens_saved) as total_saved
    FROM compaction_metrics
  `);
  const storedRow = storedResult.rows[0] as TotalsRow;
  const storedTotals = {
    totalBeforeTokens: parseInt(String(storedRow.total_before), 10),
    totalAfterTokens: parseInt(String(storedRow.total_after), 10),
    totalTokensSaved: parseInt(String(storedRow.total_saved), 10),
  };

  const recomputeResult = await pool.query(`
    SELECT
      SUM(before_tokens) as total_before,
      SUM(after_tokens) as total_after,
      SUM(before_tokens - after_tokens) as total_saved
    FROM compaction_metrics
  `);
  const recompRow = recomputeResult.rows[0] as TotalsRow;
  const recomputedTotals = {
    totalBeforeTokens: parseInt(String(recompRow.total_before), 10),
    totalAfterTokens: parseInt(String(recompRow.total_after), 10),
    totalTokensSaved: parseInt(String(recompRow.total_saved), 10),
    totalCompactions: totalRows,
    avgTokensSavedPerCompaction: totalRows > 0
      ? Math.round(parseInt(String(recompRow.total_saved), 10) / totalRows)
      : 0,
    overallReductionPercent: parseInt(String(recompRow.total_before), 10) > 0
      ? Math.round((parseInt(String(recompRow.total_saved), 10) / parseInt(String(recompRow.total_before), 10)) * 100)
      : 0,
  };

  const totalsMatch = storedTotals.totalTokensSaved === recomputedTotals.totalTokensSaved;

  const sessionResult = await pool.query(`
    SELECT session_id,
      COUNT(*) as count,
      SUM(tokens_saved) as saved,
      SUM(before_tokens) as before,
      SUM(after_tokens) as after,
      MIN(created_at) as first,
      MAX(created_at) as last
    FROM compaction_metrics
    GROUP BY session_id
    ORDER BY saved DESC
    LIMIT 20
  `);

  const sessionBreakdown: SessionBreakdown[] = (sessionResult.rows as SessionBreakdownRow[]).map((row) => ({
    sessionId: row.session_id,
    compactionCount: parseInt(String(row.count), 10),
    tokensSaved: parseInt(String(row.saved), 10),
    beforeTokens: parseInt(String(row.before), 10),
    afterTokens: parseInt(String(row.after), 10),
    firstCompaction: row.first,
    lastCompaction: row.last,
  }));

  const allClean = negativeValues.length === 0
    && mathErrors.length === 0
    && zeroBeforeOrAfter.length === 0
    && savedExceedsBefore.length === 0
    && afterExceedsBefore.length === 0
    && duplicateIds.length === 0
    && totalsMatch;

  const k = (n: number) => n >= 1_000_000_000 ? `${(n / 1_000_000_000).toFixed(2)}B`
    : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K`
    : String(n);

  const summary = allClean
    ? `AUDIT PASSED. ${totalRows} compactions verified. ${k(recomputedTotals.totalTokensSaved)} tokens saved (${recomputedTotals.overallReductionPercent}% reduction). No duplicates, negative values, or math errors found. Stored totals match recomputed.`
    : `AUDIT ISSUES FOUND. ${negativeValues.length} negative values, ${mathErrors.length} math errors, ${zeroBeforeOrAfter.length} zero fields, ${savedExceedsBefore.length} saved>before, ${afterExceedsBefore.length} after>before, ${duplicateIds.length} possible duplicates. Totals ${totalsMatch ? 'match' : 'MISMATCH'}.`;

  return {
    totalRows,
    statusBreakdown,
    duplicateIds,
    negativeValues,
    mathErrors,
    zeroBeforeOrAfter,
    savedExceedsBefore,
    afterExceedsBefore,
    recomputedTotals,
    storedTotals,
    totalsMatch,
    sessionBreakdown,
    passed: allClean,
    summary,
  };
}

export function formatAuditReport(result: AuditResult): string {
  return formatAuditReportInner(result);
}

export function formatAuditAvailability(availability: AuditAvailability): { title: string; output: string } {
  if (!availability.available) {
    const reasonMessages: Record<string, string> = {
      table_missing: 'Compaction audit unavailable: compaction_metrics table does not exist',
      schema_incomplete: 'Compaction audit unavailable: compaction_metrics schema is incomplete (columns missing)',
      query_unsupported: 'Compaction audit unavailable: database runtime does not support window functions required for duplicate detection',
    };
    return {
      title: 'Compaction Audit UNAVAILABLE',
      output: reasonMessages[availability.reason] ?? `Compaction audit unavailable: ${availability.reason}`,
    };
  }
  return {
    title: availability.passed ? 'Compaction Audit PASSED' : 'Compaction Audit ISSUES FOUND',
    output: formatAuditReportInner(availability.result),
  };
}

function formatAuditReportInner(result: AuditResult): string {
  const lines: string[] = [];

  lines.push('=== Compaction Telemetry Audit Report ===');
  lines.push('');
  lines.push(`Status: ${result.passed ? 'PASSED' : 'ISSUES FOUND'}`);
  lines.push(`Total compaction records: ${result.totalRows}`);
  lines.push('');
  lines.push('--- Status Breakdown ---');
  lines.push(`  Compressed:          ${result.statusBreakdown.compressed}`);
  lines.push(`  Skipped under budget: ${result.statusBreakdown.skipped_under_budget}`);
  lines.push(`  Failed:              ${result.statusBreakdown.failed}`);
  lines.push('');

  lines.push('--- Recomputed Totals (from raw before/after) ---');
  const rt = result.recomputedTotals;
  lines.push(`  Before:  ${rt.totalBeforeTokens.toLocaleString()} tokens`);
  lines.push(`  After:   ${rt.totalAfterTokens.toLocaleString()} tokens`);
  lines.push(`  Saved:   ${rt.totalTokensSaved.toLocaleString()} tokens (${rt.overallReductionPercent}% reduction)`);
  lines.push(`  Avg saved per compaction: ${rt.avgTokensSavedPerCompaction.toLocaleString()} tokens`);
  lines.push('');

  lines.push('--- Stored vs Recomputed ---');
  lines.push(`  Stored SUM(tokens_saved):  ${result.storedTotals.totalTokensSaved.toLocaleString()}`);
  lines.push(`  Recomputed SUM(before-after): ${result.recomputedTotals.totalTokensSaved.toLocaleString()}`);
  lines.push(`  Match: ${result.totalsMatch ? 'YES' : 'NO - MISMATCH'}`);
  lines.push('');

  lines.push('--- Anomaly Checks ---');
  lines.push(`  Negative values: ${result.negativeValues.length}`);
  lines.push(`  Math errors (saved != before - after): ${result.mathErrors.length}`);
  lines.push(`  Zero before/after tokens: ${result.zeroBeforeOrAfter.length}`);
  lines.push(`  Saved exceeds before: ${result.savedExceedsBefore.length}`);
  lines.push(`  After exceeds before (expansion): ${result.afterExceedsBefore.length}`);
  lines.push(`  Possible duplicate rows: ${result.duplicateIds.length}`);
  lines.push('');

  if (result.negativeValues.length > 0) {
    lines.push('--- Negative Values ---');
    for (const a of result.negativeValues.slice(0, 10)) {
      lines.push(`  Row ${a.id} (session ${a.sessionId.slice(0, 8)}): ${a.field} — expected ${a.expected}, got ${a.actual}`);
    }
    if (result.negativeValues.length > 10) lines.push(`  ... and ${result.negativeValues.length - 10} more`);
    lines.push('');
  }

  if (result.mathErrors.length > 0) {
    lines.push('--- Math Errors ---');
    for (const a of result.mathErrors.slice(0, 10)) {
      lines.push(`  Row ${a.id} (session ${a.sessionId.slice(0, 8)}): ${a.field} — expected ${a.expected}, got ${a.actual}`);
    }
    if (result.mathErrors.length > 10) lines.push(`  ... and ${result.mathErrors.length - 10} more`);
    lines.push('');
  }

  if (result.zeroBeforeOrAfter.length > 0) {
    lines.push('--- Zero Before/After ---');
    for (const a of result.zeroBeforeOrAfter.slice(0, 10)) {
      lines.push(`  Row ${a.id} (session ${a.sessionId.slice(0, 8)}): ${a.field} — expected ${a.expected}, got ${a.actual}`);
    }
    if (result.zeroBeforeOrAfter.length > 10) lines.push(`  ... and ${result.zeroBeforeOrAfter.length - 10} more`);
    lines.push('');
  }

  if (result.afterExceedsBefore.length > 0) {
    lines.push('--- After Exceeds Before (Compaction Expansion) ---');
    for (const a of result.afterExceedsBefore.slice(0, 10)) {
      lines.push(`  Row ${a.id} (session ${a.sessionId.slice(0, 8)}): ${a.field} — expected ${a.expected}, got ${a.actual}`);
    }
    if (result.afterExceedsBefore.length > 10) lines.push(`  ... and ${result.afterExceedsBefore.length - 10} more`);
    lines.push('');
  }

  lines.push('--- Top 20 Sessions by Tokens Saved ---');
  for (const s of result.sessionBreakdown) {
    lines.push(`  ${s.sessionId.slice(0, 8)}: ${s.tokensSaved.toLocaleString()} saved / ${s.compactionCount} compactions / before=${s.beforeTokens.toLocaleString()} after=${s.afterTokens.toLocaleString()}`);
  }
  lines.push('');

  lines.push(`Summary: ${result.summary}`);

  return lines.join('\n');
}

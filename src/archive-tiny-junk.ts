// Phase 2C.5: Tiny-Junk Archive Path (Dry-Run Only by default)
// Reversible archive machinery for tiny_type_specific_junk candidates.
// Candidate definition mirrors src/memory-governance-report.ts filterTypeSpecificJunk.
import type { DatabaseClient, DatabasePool } from './types.js';

export const ARCHIVE_REASON = 'tiny_type_specific_junk';
const ARCHIVE_SOURCE = 'phase2c5_archive_tiny_junk';
const RESTORE_SOURCE = 'phase2c5_archive_restore';

const DEFAULT_JUNK_TYPES = ['episodic', 'conversation', 'workspace', 'repo', 'procedural'];
const DEFAULT_MAX_CONTENT_LENGTH = 120;
const DEFAULT_MIN_AGE_DAYS = 14;
const DEFAULT_LOW_ACCESS_MAX = 1;
const DEFAULT_MAX_QUALITY_SCORE = 0.4;

export interface TinyJunkArchiveOptions {
  apply?: boolean;
  batchId?: string;
  source?: string;
  note?: string;
  maxTotal?: number;
  maxContentLength?: number;
  minAgeDays?: number;
  lowAccessMax?: number;
  maxQualityScore?: number;
  junkTypes?: string[];
}

export interface TinyJunkRestoreOptions {
  apply?: boolean;
  batchId: string;
}

export interface TinyJunkSample {
  id: number;
  memoryType: string;
  snippet: string;
}

export interface TinyJunkArchiveReport {
  operation: 'archive' | 'restore';
  dryRun: boolean;
  batchId: string | null;
  source: string;
  reason: string | null;
  totalActiveJunk: number;
  alreadyArchivedForReason: number;
  eligibleCount: number;
  targetedCount: number;
  updatedCount: number;
  batchCountAfter: number;
  byType: Record<string, number>;
  sampleIds: number[];
  sampleSnippets: TinyJunkSample[];
  note: string | null;
}

interface CountRow {
  total_active_junk: number;
  already_archived_reason: number;
}

interface CandidateRow {
  id: number;
  memory_type: string;
  content: string;
}

interface DatabaseLike {
  getPool(): DatabasePool;
}

export class TinyJunkArchiver {
  constructor(private readonly database: DatabaseLike) {}

  async archive(options: TinyJunkArchiveOptions = {}): Promise<TinyJunkArchiveReport> {
    const pool = this.database.getPool();
    const params = resolveJunkParams(options);
    const counts = await loadCounts(pool, params);
    const rows = await loadCandidates(pool, params, options.maxTotal ?? 0);
    const batchId = options.batchId ?? makeBatchId();
    const report = baseArchiveReport(options, counts, rows, batchId);
    if (report.dryRun || rows.length === 0) return report;
    const ids = rows.map((r) => r.id);
    report.updatedCount = await withTransaction(pool, (client) => applyArchive(client, ids, batchId, report.source, report.note));
    report.batchCountAfter = await countBatch(pool, batchId);
    return report;
  }

  async restore(options: TinyJunkRestoreOptions): Promise<TinyJunkArchiveReport> {
    const pool = this.database.getPool();
    const ids = await loadBatchIds(pool, options.batchId);
    const report = baseRestoreReport(options, ids);
    if (report.dryRun || ids.length === 0) return report;
    report.updatedCount = await withTransaction(pool, (client) => applyRestore(client, options.batchId));
    report.batchCountAfter = await countBatch(pool, options.batchId);
    return report;
  }
}

interface JunkParams {
  junkTypes: string[];
  maxContentLength: number;
  minAgeDays: number;
  lowAccessMax: number;
  maxQualityScore: number;
}

function resolveJunkParams(options: TinyJunkArchiveOptions): JunkParams {
  return {
    junkTypes: options.junkTypes ?? DEFAULT_JUNK_TYPES,
    maxContentLength: options.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH,
    minAgeDays: options.minAgeDays ?? DEFAULT_MIN_AGE_DAYS,
    lowAccessMax: options.lowAccessMax ?? DEFAULT_LOW_ACCESS_MAX,
    maxQualityScore: options.maxQualityScore ?? DEFAULT_MAX_QUALITY_SCORE,
  };
}

function baseArchiveReport(
  options: TinyJunkArchiveOptions,
  counts: CountRow,
  rows: CandidateRow[],
  batchId: string,
): TinyJunkArchiveReport {
  const byType = countByType(rows);
  const samples = rows.slice(0, 10).map((r) => ({ id: r.id, memoryType: r.memory_type, snippet: r.content.slice(0, 120) }));
  return {
    operation: 'archive',
    dryRun: !options.apply,
    batchId,
    source: options.source ?? ARCHIVE_SOURCE,
    reason: ARCHIVE_REASON,
    totalActiveJunk: counts.total_active_junk,
    alreadyArchivedForReason: counts.already_archived_reason,
    eligibleCount: rows.length,
    targetedCount: rows.length,
    updatedCount: 0,
    batchCountAfter: 0,
    byType,
    sampleIds: rows.slice(0, 50).map((r) => r.id),
    sampleSnippets: samples,
    note: options.note ?? null,
  };
}

function baseRestoreReport(options: TinyJunkRestoreOptions, ids: number[]): TinyJunkArchiveReport {
  return {
    operation: 'restore',
    dryRun: !options.apply,
    batchId: options.batchId,
    source: RESTORE_SOURCE,
    reason: null,
    totalActiveJunk: 0,
    alreadyArchivedForReason: 0,
    eligibleCount: ids.length,
    targetedCount: ids.length,
    updatedCount: 0,
    batchCountAfter: ids.length,
    byType: {},
    sampleIds: ids.slice(0, 50),
    sampleSnippets: [],
    note: null,
  };
}

function junkWhereClause() {
  return [
    'm.superseded_by IS NULL',
    'm.archived_at IS NULL',
    `m.memory_type = ANY($1::text[])`,
    `length(m.content) < $2`,
    `EXTRACT(EPOCH FROM (now() - m.created_at)) / 86400 >= $3`,
    `COALESCE(m.access_count, 0) <= $4`,
    `COALESCE(r.recall_count, 0) = 0`,
    `COALESCE(mq.score, 0.3) <= $5`,
  ].join(' AND ');
}

function junkParams(params: JunkParams) {
  return [params.junkTypes, params.maxContentLength, params.minAgeDays, params.lowAccessMax, params.maxQualityScore];
}

async function loadCounts(pool: DatabasePool, params: JunkParams): Promise<CountRow> {
  const where = junkWhereClause();
  const args = junkParams(params);
  const result = await pool.query(
    `WITH junk AS (
       SELECT m.id
       FROM memories m
       LEFT JOIN memory_quality_scores mq ON mq.memory_id = m.id
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS recall_count FROM memory_recall_events WHERE memory_id = m.id
       ) r ON true
       WHERE ${where}
     )
     SELECT
       (SELECT COUNT(*)::int FROM junk) AS total_active_junk,
       (SELECT COUNT(*)::int FROM memories WHERE archived_at IS NOT NULL AND archive_reason = $6) AS already_archived_reason`,
    [...args, ARCHIVE_REASON],
  );
  return result.rows[0] as CountRow;
}

async function loadCandidates(pool: DatabasePool, params: JunkParams, maxTotal: number): Promise<CandidateRow[]> {
  const where = junkWhereClause();
  const args = junkParams(params);
  const limited = maxTotal > 0 ? ' LIMIT $6' : '';
  const limitedArgs = maxTotal > 0 ? [...args, maxTotal] : args;
  const result = await pool.query(
    `SELECT m.id, m.memory_type, m.content
     FROM memories m
     LEFT JOIN memory_quality_scores mq ON mq.memory_id = m.id
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS recall_count FROM memory_recall_events WHERE memory_id = m.id
     ) r ON true
     WHERE ${where}
     ORDER BY m.id${limited}`,
    limitedArgs,
  );
  return result.rows as CandidateRow[];
}

async function loadBatchIds(pool: DatabasePool, batchId: string): Promise<number[]> {
  const result = await pool.query(
    `SELECT id FROM memories WHERE archive_batch_id = $1 ORDER BY id`,
    [batchId],
  );
  return result.rows.map((row) => Number((row as { id: number }).id));
}

async function applyArchive(client: DatabaseClient, ids: number[], batchId: string, source: string, note: string | null) {
  const result = await client.query(
    `UPDATE memories
     SET archived_at = now(),
         archive_reason = $2,
         archive_batch_id = $3,
         archive_source = $4,
         archive_note = $5
     WHERE id = ANY($1::bigint[])
       AND superseded_by IS NULL
       AND archived_at IS NULL`,
    [ids, ARCHIVE_REASON, batchId, source, note],
  );
  return result.rowCount ?? 0;
}

async function applyRestore(client: DatabaseClient, batchId: string) {
  const result = await client.query(
    `UPDATE memories
     SET archived_at = NULL,
         archive_reason = NULL,
         archive_batch_id = NULL,
         archive_source = NULL,
         archive_note = NULL
     WHERE archive_batch_id = $1`,
    [batchId],
  );
  return result.rowCount ?? 0;
}

async function countBatch(pool: DatabasePool, batchId: string) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM memories WHERE archive_batch_id = $1`,
    [batchId],
  );
  return Number((result.rows[0] as { cnt: number }).cnt);
}

function countByType(rows: CandidateRow[]): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.memory_type] = (acc[row.memory_type] || 0) + 1;
    return acc;
  }, {});
}

async function withTransaction<T>(pool: DatabasePool, fn: (client: DatabaseClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function makeBatchId() {
  return `archive-tiny-junk-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

import type { DatabaseClient, DatabasePool } from './types.js';

export const ARCHIVE_REASON = 'already_superseded_duplicate';
const ARCHIVE_SOURCE = 'phase2c4_archive_apply';

export interface ArchiveOptions {
  apply?: boolean;
  batchId?: string;
  source?: string;
  note?: string;
  maxTotal?: number;
}

export interface RestoreOptions {
  apply?: boolean;
  batchId: string;
}

export interface ArchiveReport {
  operation: 'archive' | 'restore';
  dryRun: boolean;
  batchId: string | null;
  source: string;
  reason: string | null;
  totalSuperseded: number;
  alreadyArchivedForReason: number;
  eligibleCount: number;
  targetedCount: number;
  updatedCount: number;
  batchCountAfter: number;
  sampleIds: number[];
  note: string | null;
}

interface CountRow {
  total_superseded: number;
  already_archived_reason: number;
  eligible_count: number;
}

interface DatabaseLike {
  getPool(): DatabasePool;
}

export class SupersededDuplicateArchiver {
  constructor(private readonly database: DatabaseLike) {}

  async archive(options: ArchiveOptions = {}): Promise<ArchiveReport> {
    const pool = this.database.getPool();
    const counts = await loadCounts(pool);
    const ids = await loadCandidateIds(pool, options.maxTotal ?? 0);
    const batchId = options.batchId ?? makeBatchId();
    const report = baseArchiveReport(options, counts, ids, batchId);
    if (report.dryRun || ids.length === 0) return report;
    report.updatedCount = await withTransaction(pool, (client) => applyArchive(client, ids, batchId, report.source, report.note));
    report.batchCountAfter = await countBatch(pool, batchId);
    return report;
  }

  async restore(options: RestoreOptions): Promise<ArchiveReport> {
    const pool = this.database.getPool();
    const ids = await loadBatchIds(pool, options.batchId);
    const report = baseRestoreReport(options, ids);
    if (report.dryRun || ids.length === 0) return report;
    report.updatedCount = await withTransaction(pool, (client) => applyRestore(client, options.batchId));
    report.batchCountAfter = await countBatch(pool, options.batchId);
    return report;
  }
}

function baseArchiveReport(options: ArchiveOptions, counts: CountRow, ids: number[], batchId: string): ArchiveReport {
  return {
    operation: 'archive',
    dryRun: !options.apply,
    batchId,
    source: options.source ?? ARCHIVE_SOURCE,
    reason: ARCHIVE_REASON,
    totalSuperseded: counts.total_superseded,
    alreadyArchivedForReason: counts.already_archived_reason,
    eligibleCount: counts.eligible_count,
    targetedCount: ids.length,
    updatedCount: 0,
    batchCountAfter: 0,
    sampleIds: ids.slice(0, 10),
    note: options.note ?? null,
  };
}

function baseRestoreReport(options: RestoreOptions, ids: number[]): ArchiveReport {
  return {
    operation: 'restore',
    dryRun: !options.apply,
    batchId: options.batchId,
    source: 'phase2c4_archive_restore',
    reason: null,
    totalSuperseded: 0,
    alreadyArchivedForReason: 0,
    eligibleCount: ids.length,
    targetedCount: ids.length,
    updatedCount: 0,
    batchCountAfter: ids.length,
    sampleIds: ids.slice(0, 10),
    note: null,
  };
}

async function loadCounts(pool: DatabasePool): Promise<CountRow> {
  const result = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE superseded_by IS NOT NULL)::int AS total_superseded,
       COUNT(*) FILTER (WHERE superseded_by IS NOT NULL AND archived_at IS NOT NULL AND archive_reason = $1)::int AS already_archived_reason,
       COUNT(*) FILTER (WHERE superseded_by IS NOT NULL AND (archived_at IS NULL OR archive_reason IS DISTINCT FROM $1))::int AS eligible_count
     FROM memories`,
    [ARCHIVE_REASON],
  );
  return result.rows[0] as CountRow;
}

async function loadCandidateIds(pool: DatabasePool, maxTotal: number): Promise<number[]> {
  const limited = maxTotal > 0 ? ' LIMIT $2' : '';
  const params = maxTotal > 0 ? [ARCHIVE_REASON, maxTotal] : [ARCHIVE_REASON];
  const result = await pool.query(
    `SELECT id
     FROM memories
     WHERE superseded_by IS NOT NULL
       AND (archived_at IS NULL OR archive_reason IS DISTINCT FROM $1)
     ORDER BY id${limited}`,
    params,
  );
  return result.rows.map((row) => Number((row as { id: number }).id));
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
       AND superseded_by IS NOT NULL
       AND (archived_at IS NULL OR archive_reason IS DISTINCT FROM $2)`,
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
  return `archive-superseded-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

import type { DatabaseClient, DatabasePool } from './types.js';
import type {
  LineageManifestEntry,
  WorkLedgerChange,
  WorkLedgerIdentity,
  WorkLedgerSurvival,
} from './work-ledger-types.js';
import { contentHash } from './work-ledger-lineage.js';

type QueryTarget = Pick<DatabasePool | DatabaseClient, 'query'>;

export interface NewWorkLedgerChange extends WorkLedgerIdentity {
  changeId: string;
  projectRoot: string;
  filePath: string;
  beforeHash?: string;
  afterHash?: string;
  patchHash: string;
  lineageManifest: LineageManifestEntry[];
}

export async function insertWorkLedgerChange(
  target: QueryTarget,
  change: NewWorkLedgerChange,
): Promise<WorkLedgerChange> {
  const result = await target.query(
    `INSERT INTO work_ledger_changes
       (change_id, run_id, session_id, model_id, tool_call_id, tool_name,
        project_root, file_path, before_hash, after_hash, patch_hash,
        status, surviving_patch_hash, lineage_manifest, last_verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             'active', $11, $12::jsonb, now())
     RETURNING *`,
    [
      change.changeId, change.runId, change.sessionId ?? null, change.modelId,
      change.toolCallId ?? null, change.toolName, change.projectRoot, change.filePath,
      change.beforeHash ?? null, change.afterHash ?? null, change.patchHash,
      JSON.stringify(change.lineageManifest),
    ],
  );
  return rowToWorkLedgerChange(result.rows[0]);
}

export async function listFileChanges(
  target: QueryTarget,
  projectRoot: string,
  filePath: string,
): Promise<WorkLedgerChange[]> {
  const result = await target.query(
    `SELECT * FROM work_ledger_changes
     WHERE project_root = $1 AND file_path = $2
     ORDER BY created_at, change_id`,
    [projectRoot, filePath],
  );
  return result.rows.map(rowToWorkLedgerChange);
}

export async function lockWorkLedgerFile(
  target: QueryTarget,
  projectRoot: string,
  filePath: string,
): Promise<void> {
  await target.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [contentHash(JSON.stringify([projectRoot, filePath]))],
  );
}

export async function acquireWorkLedgerFileLock(
  target: QueryTarget,
  projectRoot: string,
  filePath: string,
): Promise<void> {
  await target.query(
    'SELECT pg_advisory_lock(hashtextextended($1, 0))',
    [fileLockKey(projectRoot, filePath)],
  );
}

export async function releaseWorkLedgerFileLock(
  target: QueryTarget,
  projectRoot: string,
  filePath: string,
): Promise<void> {
  await target.query(
    'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
    [fileLockKey(projectRoot, filePath)],
  );
}

export async function listRunChanges(
  target: QueryTarget,
  runId: string,
  projectRoot?: string,
): Promise<WorkLedgerChange[]> {
  const result = await target.query(
    `SELECT * FROM work_ledger_changes
     WHERE run_id = $1 AND ($2::text IS NULL OR project_root = $2)
     ORDER BY created_at, change_id`,
    [runId, projectRoot ?? null],
  );
  return result.rows.map(rowToWorkLedgerChange);
}

export async function findWorkLedgerToolChange(
  target: QueryTarget,
  runId: string,
  toolCallId: string | undefined,
  projectRoot: string,
  filePath: string,
): Promise<WorkLedgerChange | undefined> {
  if (!toolCallId) return undefined;
  const result = await target.query(
    `SELECT * FROM work_ledger_changes
     WHERE run_id = $1 AND tool_call_id = $2
       AND project_root = $3 AND file_path = $4
     LIMIT 1`,
    [runId, toolCallId, projectRoot, filePath],
  );
  return result.rows[0] ? rowToWorkLedgerChange(result.rows[0]) : undefined;
}

export async function updateWorkLedgerSurvival(
  target: QueryTarget,
  changeId: string,
  survival: WorkLedgerSurvival,
  supersederId?: string,
): Promise<void> {
  await target.query(
    `UPDATE work_ledger_changes
     SET status = $2,
         surviving_patch_hash = $3,
         last_verified_at = now(),
         superseded_by = CASE
           WHEN $4::uuid IS NULL OR $4::uuid = ANY(superseded_by) THEN superseded_by
           ELSE array_append(superseded_by, $4::uuid)
         END
     WHERE change_id = $1::uuid`,
    [changeId, survival.status, survival.survivingPatchHash ?? null, supersederId ?? null],
  );
}

export async function updateWorkLedgerSupersedes(
  target: QueryTarget,
  changeId: string,
  supersedes: string[],
): Promise<void> {
  await target.query(
    'UPDATE work_ledger_changes SET supersedes = $2::uuid[] WHERE change_id = $1::uuid',
    [changeId, supersedes],
  );
}

function rowToWorkLedgerChange(value: unknown): WorkLedgerChange {
  const row = value as Record<string, unknown>;
  return {
    changeId: String(row.change_id),
    runId: String(row.run_id),
    sessionId: optionalString(row.session_id),
    modelId: String(row.model_id),
    toolCallId: optionalString(row.tool_call_id),
    toolName: String(row.tool_name),
    projectRoot: String(row.project_root),
    filePath: String(row.file_path),
    beforeHash: optionalString(row.before_hash),
    afterHash: optionalString(row.after_hash),
    patchHash: String(row.patch_hash),
    commitSha: optionalString(row.commit_sha),
    createdAt: new Date(String(row.created_at)),
    status: row.status as WorkLedgerChange['status'],
    supersededBy: stringArray(row.superseded_by),
    supersedes: stringArray(row.supersedes),
    survivingPatchHash: optionalString(row.surviving_patch_hash),
    lineageManifest: jsonArray(row.lineage_manifest),
    lastVerifiedAt: row.last_verified_at ? new Date(String(row.last_verified_at)) : undefined,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function jsonArray(value: unknown): LineageManifestEntry[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  return Array.isArray(parsed) ? parsed as LineageManifestEntry[] : [];
}

function fileLockKey(projectRoot: string, filePath: string): string {
  return contentHash(JSON.stringify([projectRoot, filePath]));
}

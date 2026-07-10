import type { DatabaseClient, DatabasePool } from './types.js';
import type { WorkLedgerFileState } from './work-ledger-files.js';
import { evaluateSurvival } from './work-ledger-lineage.js';
import {
  findWorkLedgerToolChange,
  insertWorkLedgerChange,
  listFileChanges,
  lockWorkLedgerFile,
  updateWorkLedgerSupersedes,
  updateWorkLedgerSurvival,
  type NewWorkLedgerChange,
} from './work-ledger-store.js';
import type { WorkLedgerChange, WorkLedgerSurvival } from './work-ledger-types.js';

export interface PreparedWorkLedgerChange {
  change: NewWorkLedgerChange;
  after: WorkLedgerFileState;
}

export async function persistWorkLedgerChanges(
  client: DatabaseClient,
  prepared: PreparedWorkLedgerChange[],
): Promise<WorkLedgerChange[]> {
  if (prepared.length === 0) return [];
  try {
    await client.query('BEGIN');
    const changes: WorkLedgerChange[] = [];
    for (const item of prepared) {
      changes.push(await persistOne(client, item));
    }
    await client.query('COMMIT');
    return changes;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
    throw error;
  }
}

async function persistOne(
  client: DatabaseClient,
  prepared: PreparedWorkLedgerChange,
): Promise<WorkLedgerChange> {
  const { change, after } = prepared;
  await lockWorkLedgerFile(client, change.projectRoot, change.filePath);
  const existing = await findWorkLedgerToolChange(
    client, change.runId, change.toolCallId, change.projectRoot, change.filePath,
  );
  if (existing) return existing;
  const prior = await listFileChanges(client, change.projectRoot, change.filePath);
  const inserted = await insertWorkLedgerChange(client, change);
  const supersedes = await updatePriorChanges(client, prior, after, inserted.changeId);
  await updateWorkLedgerSupersedes(client, inserted.changeId, supersedes);
  inserted.supersedes = supersedes;
  return inserted;
}

async function updatePriorChanges(
  target: DatabaseClient,
  prior: WorkLedgerChange[],
  current: WorkLedgerFileState,
  supersederId: string,
): Promise<string[]> {
  const supersedes: string[] = [];
  for (const change of prior) {
    const survival = evaluateSurvival(change, current);
    const degraded = isDegraded(change, survival);
    await updateWorkLedgerSurvival(target, change.changeId, survival, degraded ? supersederId : undefined);
    if (degraded) supersedes.push(change.changeId);
  }
  return supersedes;
}

function isDegraded(change: WorkLedgerChange, survival: WorkLedgerSurvival): boolean {
  if (change.status === survival.status && change.survivingPatchHash === survival.survivingPatchHash) return false;
  return survival.status !== 'active';
}

export async function correlateWorkLedgerCommit(
  pool: DatabasePool,
  changeIds: string[],
  commitSha: string,
): Promise<number> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commitSha)) {
    throw new Error('Work Ledger commit SHA must be 40 or 64 hexadecimal characters');
  }
  if (changeIds.length === 0) return 0;
  const result = await pool.query(
    `UPDATE work_ledger_changes SET commit_sha = $2
     WHERE change_id = ANY($1::uuid[])`,
    [changeIds, commitSha.toLowerCase()],
  );
  return result.rowCount ?? 0;
}

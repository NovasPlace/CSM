import type { DatabasePool } from './types.js';
import { acquireCaptureLease, releaseCaptureLease } from './work-ledger-capture-lock.js';
import {
  readWorkLedgerFile,
  resolveCanonicalWorkLedgerPaths,
} from './work-ledger-files.js';
import { evaluateSurvival } from './work-ledger-lineage.js';
import { updateWorkLedgerSurvival } from './work-ledger-store.js';
import type { WorkLedgerChange, WorkLedgerSurvival } from './work-ledger-types.js';

export async function verifyWorkLedgerChanges(
  pool: DatabasePool,
  changes: WorkLedgerChange[],
  maxFileBytes: number,
): Promise<WorkLedgerChange[]> {
  for (const group of groupFileChanges(changes)) {
    const first = group[0];
    const lease = await acquireCaptureLease(pool, first.projectRoot, [first.filePath]);
    try {
      const [target] = await resolveCanonicalWorkLedgerPaths(first.projectRoot, [first.filePath]);
      const current = await readWorkLedgerFile(target.absolutePath, maxFileBytes);
      for (const change of group) {
        const survival = evaluateSurvival(change, current);
        await updateWorkLedgerSurvival(lease.client, change.changeId, survival);
        applySurvival(change, survival);
      }
    } finally {
      await releaseCaptureLease(lease);
    }
  }
  return changes.filter(isSurviving);
}

function groupFileChanges(changes: WorkLedgerChange[]): WorkLedgerChange[][] {
  const groups = new Map<string, WorkLedgerChange[]>();
  for (const change of changes) {
    const key = JSON.stringify([change.projectRoot, change.filePath]);
    const group = groups.get(key) ?? [];
    group.push(change);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function applySurvival(change: WorkLedgerChange, survival: WorkLedgerSurvival): void {
  change.status = survival.status;
  change.survivingPatchHash = survival.survivingPatchHash;
  change.lastVerifiedAt = new Date();
}

function isSurviving(change: WorkLedgerChange): boolean {
  return change.status === 'active' || change.status === 'partially_superseded';
}

import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DatabaseClient, DatabasePool } from './types.js';
import {
  acquireCaptureLease,
  releaseCaptureLease,
  workLedgerCaptureKey,
} from './work-ledger-capture-lock.js';
import { WorkLedgerPendingCaptures } from './work-ledger-pending.js';
import {
  extractWorkLedgerPaths,
  assertWorkLedgerPathSafe,
  readWorkLedgerFile,
  resolveCanonicalWorkLedgerPaths,
  type WorkLedgerFileState,
} from './work-ledger-files.js';
import { buildLineageManifest, evaluateSurvival, patchHash } from './work-ledger-lineage.js';
import {
  listFileChanges,
  listRunChanges,
  updateWorkLedgerSurvival,
  type NewWorkLedgerChange,
} from './work-ledger-store.js';
import {
  correlateWorkLedgerCommit,
  persistWorkLedgerChanges,
  type PreparedWorkLedgerChange,
} from './work-ledger-persistence.js';
import type {
  WorkLedgerCaptureInput,
  WorkLedgerChange,
  WorkLedgerConfig,
} from './work-ledger-types.js';
import { verifyWorkLedgerChanges } from './work-ledger-verification.js';

interface PendingFileCapture {
  input: WorkLedgerCaptureInput;
  absolutePath: string;
  filePath: string;
  before: WorkLedgerFileState;
}

export class WorkLedger {
  private readonly pending = new WorkLedgerPendingCaptures<PendingFileCapture>();

  constructor(
    private readonly pool: DatabasePool,
    private readonly config: WorkLedgerConfig,
  ) {}

  async captureBefore(input: WorkLedgerCaptureInput): Promise<void> {
    if (!this.config.enabled) return;
    const projectRoot = await realpath(resolve(input.projectRoot));
    const normalized = { ...input, projectRoot };
    const key = workLedgerCaptureKey(normalized);
    if (this.pending.has(key)) throw new Error('Work Ledger capture is already pending for this tool call');
    const targets = await resolveCanonicalWorkLedgerPaths(
      projectRoot,
      extractWorkLedgerPaths(input.args),
    );
    if (targets.length === 0) return;
    const lease = await acquireCaptureLease(this.pool, projectRoot, targets.map((item) => item.relativePath));
    const captures: PendingFileCapture[] = [];
    try {
      for (const target of targets) {
        await assertWorkLedgerPathSafe(projectRoot, target.absolutePath);
        const before = await readWorkLedgerFile(target.absolutePath, this.config.maxFileBytes);
        await this.refreshFile(lease.client, projectRoot, target.relativePath, before);
        captures.push({ input: normalized, ...target, filePath: target.relativePath, before });
      }
      this.pending.set(key, captures, lease, captureTimeout(this.config.captureTimeoutMs));
    } catch (error) {
      await releaseCaptureLease(lease);
      throw error;
    }
  }

  async captureAfter(input: WorkLedgerCaptureInput): Promise<WorkLedgerChange[]> {
    if (!this.config.enabled) return [];
    const normalized = { ...input, projectRoot: await realpath(resolve(input.projectRoot)) };
    const key = workLedgerCaptureKey(normalized);
    const group = this.pending.take(key);
    if (!group) {
      if (extractWorkLedgerPaths(input.args).length === 0) return [];
      throw new Error('Work Ledger completion has no matching pending capture');
    }
    try {
      const afterTargets = await resolveCanonicalWorkLedgerPaths(
        normalized.projectRoot,
        extractWorkLedgerPaths(normalized.args),
      );
      assertCaptureIdentity(group.captures, normalized, afterTargets);
      const prepared: PreparedWorkLedgerChange[] = [];
      for (const capture of group.captures) {
        await assertWorkLedgerPathSafe(capture.input.projectRoot, capture.absolutePath);
        const after = await readWorkLedgerFile(capture.absolutePath, this.config.maxFileBytes);
        if (capture.before.hash === after.hash && capture.before.exists === after.exists) continue;
        prepared.push(this.prepareCapture(capture, after));
      }
      return await persistWorkLedgerChanges(group.lease.client, prepared);
    } finally {
      await releaseCaptureLease(group.lease);
    }
  }

  async listSurvivingChanges(runId: string, projectRoot?: string): Promise<WorkLedgerChange[]> {
    if (!this.config.enabled) return [];
    const root = projectRoot ? await realpath(resolve(projectRoot)) : undefined;
    const changes = await listRunChanges(this.pool, runId, root);
    return verifyWorkLedgerChanges(this.pool, changes, this.config.maxFileBytes);
  }

  async correlateCommit(changeIds: string[], commitSha: string): Promise<number> {
    if (!this.config.enabled) return 0;
    return correlateWorkLedgerCommit(this.pool, changeIds, commitSha);
  }

  async abortCapture(input: WorkLedgerCaptureInput): Promise<boolean> {
    if (!this.config.enabled) return false;
    const projectRoot = await realpath(resolve(input.projectRoot));
    return this.pending.abort(workLedgerCaptureKey({ ...input, projectRoot }));
  }

  async dispose(): Promise<void> {
    await this.pending.dispose();
  }

  private prepareCapture(
    capture: PendingFileCapture,
    after: WorkLedgerFileState,
  ): PreparedWorkLedgerChange {
    const manifest = buildLineageManifest(capture.before.content, after.content);
    const change: NewWorkLedgerChange = {
      ...capture.input,
      changeId: randomUUID(),
      filePath: capture.filePath,
      beforeHash: capture.before.hash,
      afterHash: after.hash,
      patchHash: patchHash(capture.before.hash, after.hash, manifest),
      lineageManifest: manifest,
    };
    return { change, after };
  }

  private async refreshFile(
    target: DatabaseClient,
    projectRoot: string,
    filePath: string,
    current: WorkLedgerFileState,
  ): Promise<void> {
    const changes = await listFileChanges(target, projectRoot, filePath);
    for (const change of changes) {
      await updateWorkLedgerSurvival(target, change.changeId, evaluateSurvival(change, current));
    }
  }

}

function assertCaptureIdentity(
  captures: PendingFileCapture[],
  after: WorkLedgerCaptureInput,
  afterTargets: Array<{ relativePath: string }>,
): void {
  const before = captures[0]?.input;
  if (!before || before.modelId !== after.modelId) {
    throw new Error('Work Ledger completion identity does not match its pending capture');
  }
  const beforePaths = captures.map((capture) => capture.filePath).sort();
  const afterPaths = afterTargets.map((target) => target.relativePath).sort();
  if (JSON.stringify(beforePaths) !== JSON.stringify(afterPaths)) {
    throw new Error('Work Ledger completion paths do not match its pending capture');
  }
}

function captureTimeout(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) >= 1_000 ? value as number : 300_000;
}

import { getLogger } from './logger.js';
import {
  releaseCaptureLease,
  type WorkLedgerCaptureLease,
} from './work-ledger-capture-lock.js';

export interface PendingWorkLedgerCapture<T> {
  captures: T[];
  lease: WorkLedgerCaptureLease;
  timer: ReturnType<typeof setTimeout>;
}

export class WorkLedgerPendingCaptures<T> {
  private readonly groups = new Map<string, PendingWorkLedgerCapture<T>>();

  has(key: string): boolean {
    return this.groups.has(key);
  }

  set(
    key: string,
    captures: T[],
    lease: WorkLedgerCaptureLease,
    timeoutMs: number,
  ): void {
    const timer = setTimeout(() => void this.expire(key), timeoutMs);
    timer.unref();
    this.groups.set(key, { captures, lease, timer });
  }

  take(key: string): PendingWorkLedgerCapture<T> | undefined {
    const group = this.groups.get(key);
    if (!group) return undefined;
    this.groups.delete(key);
    clearTimeout(group.timer);
    return group;
  }

  async abort(key: string): Promise<boolean> {
    const group = this.take(key);
    if (!group) return false;
    await releaseCaptureLease(group.lease);
    return true;
  }

  async dispose(): Promise<void> {
    const groups = [...this.groups.values()];
    this.groups.clear();
    for (const group of groups) clearTimeout(group.timer);
    const results = await Promise.allSettled(groups.map((group) => releaseCaptureLease(group.lease)));
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Work Ledger pending capture cleanup failed');
  }

  private async expire(key: string): Promise<void> {
    try {
      if (await this.abort(key)) getLogger().warn('Work Ledger capture lease expired before completion');
    } catch (error) {
      getLogger().error('Work Ledger capture lease cleanup failed', asError(error));
    }
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

import { createHash } from 'node:crypto';
import type {
  LineageManifestEntry,
  WorkLedgerStatus,
  WorkLedgerSurvival,
} from './work-ledger-types.js';

export function contentHash(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function buildLineageManifest(
  before: string,
  after: string,
): LineageManifestEntry[] {
  const beforeCounts = lineCounts(before);
  const afterCounts = lineCounts(after);
  const hashes = new Set([...beforeCounts.keys(), ...afterCounts.keys()]);
  return [...hashes]
    .map((hash) => ({
      hash,
      beforeCount: beforeCounts.get(hash) ?? 0,
      afterCount: afterCounts.get(hash) ?? 0,
    }))
    .filter((entry) => entry.beforeCount !== entry.afterCount)
    .sort((left, right) => left.hash.localeCompare(right.hash));
}

export function patchHash(
  beforeHash: string | undefined,
  afterHash: string | undefined,
  manifest: LineageManifestEntry[],
): string {
  return contentHash(JSON.stringify({ beforeHash, afterHash, manifest }));
}

export function evaluateSurvival(
  change: {
    beforeHash?: string;
    afterHash?: string;
    patchHash: string;
    lineageManifest: LineageManifestEntry[];
    status?: WorkLedgerStatus;
    survivingPatchHash?: string;
  },
  current: { hash?: string; content: string },
): WorkLedgerSurvival {
  if (isTerminal(change.status)) return exactSurvival(change.status, change, false);
  if (current.hash === change.afterHash) {
    return preservePartial(change, exactSurvival('active', change, true));
  }
  if (current.hash === change.beforeHash) return exactSurvival('reverted', change, false);
  const currentCounts = lineCounts(current.content);
  const units = survivingUnits(change.lineageManifest, currentCounts);
  const totalUnits = totalChangedUnits(change.lineageManifest);
  const survivingCount = units.reduce((sum, unit) => sum + unit.count, 0);
  const status = lineageStatus(survivingCount, totalUnits);
  const survivingPatchHash = status === 'active'
    ? change.patchHash
    : units.length ? contentHash(JSON.stringify(units)) : undefined;
  return preservePartial(change, {
    status,
    survivingPatchHash,
    survivingUnits: survivingCount,
    totalUnits,
  });
}

function lineCounts(content: string): Map<string, number> {
  const counts = new Map<string, number>();
  if (content.length === 0) return counts;
  for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
    const hash = contentHash(line);
    counts.set(hash, (counts.get(hash) ?? 0) + 1);
  }
  return counts;
}

function survivingUnits(
  manifest: LineageManifestEntry[],
  current: Map<string, number>,
): Array<{ hash: string; count: number }> {
  return manifest.flatMap((entry) => {
    const currentCount = current.get(entry.hash) ?? 0;
    const delta = entry.afterCount - entry.beforeCount;
    const count = delta > 0
      ? clamp(currentCount - entry.beforeCount, 0, delta)
      : clamp(entry.beforeCount - currentCount, 0, -delta);
    return count > 0 ? [{ hash: entry.hash, count }] : [];
  });
}

function totalChangedUnits(manifest: LineageManifestEntry[]): number {
  return manifest.reduce(
    (sum, entry) => sum + Math.abs(entry.afterCount - entry.beforeCount),
    0,
  );
}

function lineageStatus(survivingEntries: number, totalUnits: number): WorkLedgerStatus {
  if (survivingEntries === 0) return 'superseded';
  if (survivingEntries === totalUnits) return 'active';
  return 'partially_superseded';
}

function exactSurvival(
  status: WorkLedgerStatus,
  change: { patchHash: string; lineageManifest: LineageManifestEntry[] },
  survives: boolean,
): WorkLedgerSurvival {
  const totalUnits = totalChangedUnits(change.lineageManifest);
  return {
    status,
    survivingPatchHash: survives ? change.patchHash : undefined,
    survivingUnits: survives ? totalUnits : 0,
    totalUnits,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isTerminal(status: WorkLedgerStatus | undefined): status is 'superseded' | 'reverted' {
  return status === 'superseded' || status === 'reverted';
}

function preservePartial(
  change: { status?: WorkLedgerStatus; survivingPatchHash?: string },
  survival: WorkLedgerSurvival,
): WorkLedgerSurvival {
  if (change.status !== 'partially_superseded') return survival;
  if (survival.status === 'active') return keepPriorPartial(change, survival);
  if (survival.status !== 'partially_superseded') return survival;
  if (survival.survivingPatchHash === change.survivingPatchHash) return survival;
  return { ...survival, status: 'superseded', survivingPatchHash: undefined, survivingUnits: 0 };
}

function keepPriorPartial(
  change: { survivingPatchHash?: string },
  survival: WorkLedgerSurvival,
): WorkLedgerSurvival {
  return { ...survival, status: 'partially_superseded', survivingPatchHash: change.survivingPatchHash };
}

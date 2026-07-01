/**
 * Per-part compaction tracking.
 *
 * Detects reprocessing loops by counting how many times each part
 * (keyed by `msgIndex:partIndex`) is compacted. A part compacted
 * more than once across cycles indicates a detection-signal failure
 * — the compactor should have skipped it but didn't.
 */

import { getLogger } from './logger.js';

export interface ReprocessingEntry {
  partKey: string;
  compactCount: number;
}

export class CompactionTracker {
  private counts = new Map<string, number>();

  /** Record a compaction of `partKey`. Returns the new count. */
  record(partKey: string): number {
    const c = (this.counts.get(partKey) ?? 0) + 1;
    this.counts.set(partKey, c);
    if (c > 1) getLogger().warn(`reprocessing: ${partKey} compacted ${c}x`);
    return c;
  }

  /** Returns parts compacted more than once, sorted by count desc. */
  getReprocessingReport(): ReprocessingEntry[] {
    const out: ReprocessingEntry[] = [];
    for (const [partKey, compactCount] of this.counts) {
      if (compactCount > 1) out.push({ partKey, compactCount });
    }
    return out.sort((a, b) => b.compactCount - a.compactCount);
  }

  reset(): void {
    this.counts.clear();
  }
}

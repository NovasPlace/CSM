/**
 * LoopSignalDetector - 5-gate loop detection for Phase 5A
 *
 * Per-session rolling N=20 ring buffer of recent tool executions. Fires a
 * `loop_signal` packet only when ALL FIVE gates are satisfied:
 *   A. Same `toolName` appeared 3+ times in the window.
 *   B. At least one `error_packet` exists for that tool in the window.
 *   C. No `milestone_packet` fired in the last 10 tool calls.
 *   D1. Similar args: 3+ calls in the window share the same normalized arg hash.
 *   D2. No-progress evidence (any one suffices):
 *        - output hash identical across 2+ similar-args calls, OR
 *        - targeted filePath has unchanged mtime since first similar call, OR
 *        - error text hash identical across 2+ similar calls.
 *
 * Non-blocking — detection failures are swallowed. Caller must wrap packet
 * writes in try/catch regardless.
 */

import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';

const WINDOW_SIZE = 20;
const MIN_REPEAT = 3;
const MILESTONE_GAP = 10;

export interface LoopEntry {
  toolName: string;
  inputHash: string;
  outputHash: string;
  errorHash: string;
  filePath: string | null;
  isError: boolean;
  isMilestone: boolean;
  timestamp: number;
}

export interface LoopSignal {
  toolName: string;
  callCount: number;
  correlationId: string;
  evidenceRefs: string[];
  gateD1: boolean;  // similar args
  gateD2: boolean;  // no-progress
  gateD2Reason: string;
}

export class LoopSignalDetector {
  private buffer: LoopEntry[] = [];
  private milestoneIndex = -1;

  constructor(private readonly windowSize = WINDOW_SIZE) {}

  record(entry: Omit<LoopEntry, 'timestamp'>): void {
    const full: LoopEntry = { ...entry, timestamp: Date.now() };
    this.buffer.push(full);
    if (this.buffer.length > this.windowSize) {
      this.buffer.shift();
    }
    if (full.isMilestone) {
      this.milestoneIndex = this.buffer.length - 1;
    }
  }

  check(): LoopSignal | null {
    if (this.buffer.length < MIN_REPEAT) return null;

    const toolCounts = new Map<string, LoopEntry[]>();
    for (const e of this.buffer) {
      const list = toolCounts.get(e.toolName) ?? [];
      list.push(e);
      toolCounts.set(e.toolName, list);
    }

    for (const [toolName, entries] of toolCounts) {
      if (entries.length < MIN_REPEAT) continue;

      // Gate B: at least one error for this tool
      const hasError = entries.some(e => e.isError);
      if (!hasError) continue;

      // Gate C: no milestone in last MILESTONE_GAP calls
      const recentMilestoneIdx = this.findRecentMilestoneIndex();
      const gap = this.buffer.length - 1 - recentMilestoneIdx;
      if (recentMilestoneIdx >= 0 && gap < MILESTONE_GAP) continue;

      // Gate D1: similar args (3+ share same input hash)
      const argBuckets = new Map<string, LoopEntry[]>();
      for (const e of entries) {
        const list = argBuckets.get(e.inputHash) ?? [];
        list.push(e);
        argBuckets.set(e.inputHash, list);
      }
      let gateD1 = false;
      let similarEntries: LoopEntry[] = [];
      for (const [, bucket] of argBuckets) {
        if (bucket.length >= MIN_REPEAT) {
          gateD1 = true;
          similarEntries = bucket;
          break;
        }
      }
      if (!gateD1) continue;

      // Gate D2: no-progress
      const d2Result = this.checkNoProgress(similarEntries);
      if (!d2Result.pass) continue;

      // All gates passed — emit signal
      return {
        toolName,
        callCount: entries.length,
        correlationId: randomUUID(),
        evidenceRefs: entries.map(e => `packet:${e.toolName}:${e.timestamp}`),
        gateD1: true,
        gateD2: true,
        gateD2Reason: d2Result.reason,
      };
    }
    return null;
  }

  private findRecentMilestoneIndex(): number {
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (this.buffer[i].isMilestone) return i;
    }
    return -1;
  }

  private checkNoProgress(entries: LoopEntry[]): { pass: boolean; reason: string } {
    // D2a: output hash identical across 2+ similar-args calls
    const outputCounts = new Map<string, number>();
    for (const e of entries) {
      if (!e.outputHash) continue;
      outputCounts.set(e.outputHash, (outputCounts.get(e.outputHash) ?? 0) + 1);
    }
    for (const [, count] of outputCounts) {
      if (count >= 2) return { pass: true, reason: 'output_hash_identical' };
    }

    // D2b: filePath mtime unchanged
    const filePaths = entries.filter(e => e.filePath).map(e => e.filePath!);
    if (filePaths.length >= 2) {
      const firstPath = filePaths[0];
      try {
        const firstStat = statSync(firstPath, { throwIfNoEntry: false });
        if (firstStat) {
          const unchanged = filePaths.slice(1).every(p => {
            try {
              const stat = statSync(p, { throwIfNoEntry: false });
              return stat && stat.mtimeMs === firstStat.mtimeMs;
            } catch {
              return false;
            }
          });
          if (unchanged) return { pass: true, reason: 'filepath_mtime_unchanged' };
        }
      } catch {
        // stat failed — skip this sub-gate
      }
    }

    // D2c: error text hash identical across 2+ similar calls
    const errorCounts = new Map<string, number>();
    for (const e of entries) {
      if (!e.isError || !e.errorHash) continue;
      errorCounts.set(e.errorHash, (errorCounts.get(e.errorHash) ?? 0) + 1);
    }
    for (const [, count] of errorCounts) {
      if (count >= 2) return { pass: true, reason: 'error_hash_identical' };
    }

    return { pass: false, reason: '' };
  }

  clearHistory(): void {
    this.buffer = [];
    this.milestoneIndex = -1;
  }
}
/**
 * LintDeltaTracker — store lint/test baselines, compute deltas.
 *
 * Stores snapshots as `type='episodic'` with `metadata.source_kind='lint_baseline'`.
 * On each lint run, compares with last snapshot and returns the delta.
 *
 * UX: "Lint delta: 96 -> 97 warnings
 *      New warning:
 *      - src/foo.ts:123 no-explicit-any"
 *
 * No raw LIKE interpolation — uses parameterized queries for filePath lookups.
 */

import { getLogger } from './logger.js';
import type { MemoryManager } from './memory-manager.js';
import type { Memory, MemorySaveOptions, MemoryListOptions } from './types.js';

export interface LintSnapshot {
  errors: number;
  warnings: number;
  maxWarnings: number;
  changedFiles: string[];
  toolName: string;
  timestamp: string;
  memoryId?: number;
}

export interface LintDelta {
  previous: LintSnapshot | null;
  current: LintSnapshot;
  warningDelta: number;
  errorDelta: number;
  newWarnings: string[];
  resolvedWarnings: string[];
  formatted: string;
}

export class LintDeltaTracker {
  private log = getLogger();

  constructor(private memoryManager: MemoryManager) {}

  async recordSnapshot(params: {
    errors: number;
    warnings: number;
    maxWarnings: number;
    changedFiles: string[];
    toolName: string;
    sessionId?: string;
    projectId?: string;
  }): Promise<LintDelta> {
    const now = new Date().toISOString();
    const previous = await this.getLastSnapshot(params.projectId);

    const metadata: Record<string, unknown> = {
      source_kind: 'lint_baseline',
      errors: params.errors,
      warnings: params.warnings,
      max_warnings: params.maxWarnings,
      changed_files: params.changedFiles,
      tool_name: params.toolName,
      timestamp: now,
    };

    const saveOpts: MemorySaveOptions = {
      content: `Lint baseline: ${params.warnings} warnings, ${params.errors} errors (${params.toolName})`,
      type: 'episodic',
      importance: 0.4,
      source: 'manual',
      tags: ['lint-baseline'],
      metadata,
      sessionId: params.sessionId,
      projectId: params.projectId,
    };

    const memory = await this.memoryManager.saveMemory(saveOpts);

    const current: LintSnapshot = {
      errors: params.errors,
      warnings: params.warnings,
      maxWarnings: params.maxWarnings,
      changedFiles: params.changedFiles,
      toolName: params.toolName,
      timestamp: now,
      memoryId: memory.id,
    };

    const delta = this.computeDelta(previous, current);
    if (delta.warningDelta !== 0 || delta.errorDelta !== 0) {
      this.log.info(`lint delta: ${previous?.warnings ?? 0} → ${current.warnings} warnings (${delta.warningDelta >= 0 ? '+' : ''}${delta.warningDelta})`);
    }

    return delta;
  }

  async getLastSnapshot(projectId?: string): Promise<LintSnapshot | null> {
    const opts: MemoryListOptions = {
      type: 'episodic',
      tags: ['lint-baseline'],
      limit: 1,
      sortBy: 'recent',
    };
    if (projectId) opts.projectId = projectId;

    const memories = await this.memoryManager.listMemories(opts);
    if (memories.length === 0) return null;
    return this.toSnapshot(memories[0]);
  }

  private computeDelta(previous: LintSnapshot | null, current: LintSnapshot): LintDelta {
    const warningDelta = current.warnings - (previous?.warnings ?? 0);
    const errorDelta = current.errors - (previous?.errors ?? 0);

    const newWarnings: string[] = [];
    const resolvedWarnings: string[] = [];

    if (current.changedFiles && previous?.changedFiles) {
      const prevFiles = new Set(previous.changedFiles);
      for (const f of current.changedFiles) {
        if (!prevFiles.has(f)) newWarnings.push(f);
      }
      const currFiles = new Set(current.changedFiles);
      for (const f of previous.changedFiles) {
        if (!currFiles.has(f)) resolvedWarnings.push(f);
      }
    }

    const formatted = this.formatDelta(previous, current, warningDelta, errorDelta, newWarnings);

    return {
      previous,
      current,
      warningDelta,
      errorDelta,
      newWarnings,
      resolvedWarnings,
      formatted,
    };
  }

  private formatDelta(
    previous: LintSnapshot | null,
    current: LintSnapshot,
    warningDelta: number,
    errorDelta: number,
    newWarnings: string[],
  ): string {
    const prevCount = previous?.warnings ?? 0;
    const lines: string[] = [];

    if (warningDelta === 0 && errorDelta === 0) {
      lines.push(`Lint: ${current.warnings} warnings, ${current.errors} errors (no change)`);
    } else {
      const sign = warningDelta >= 0 ? '+' : '';
      lines.push(`Lint delta: ${prevCount} → ${current.warnings} warnings (${sign}${warningDelta})`);
      if (errorDelta !== 0) {
        lines.push(`Errors: ${previous?.errors ?? 0} → ${current.errors} (${errorDelta >= 0 ? '+' : ''}${errorDelta})`);
      }
      if (newWarnings.length > 0) {
        lines.push('New warning sources:');
        for (const f of newWarnings.slice(0, 5)) {
          lines.push(`  - ${f}`);
        }
      }
    }

    return lines.join('\n');
  }

  private toSnapshot(m: Memory): LintSnapshot {
    const meta = (m.metadata ?? {}) as Record<string, unknown>;
    return {
      errors: (meta.errors as number) ?? 0,
      warnings: (meta.warnings as number) ?? 0,
      maxWarnings: (meta.max_warnings as number) ?? 0,
      changedFiles: (meta.changed_files as string[]) ?? [],
      toolName: (meta.tool_name as string) ?? 'lint:src',
      timestamp: (meta.timestamp as string) ?? String(m.createdAt),
      memoryId: m.id,
    };
  }
}
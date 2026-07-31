/**
 * Native-runtime compaction trigger.
 *
 * The OpenCode plugin path fires compaction from a `messages.transform` hook
 * (see `messages-transform.ts`). Native hosts (Claude Code, Codex) do not emit
 * that event, so `ContextCompactor.compact()` — the only code that increments
 * cumulative compaction stats — is never invoked for native sessions.
 *
 * This module exposes a `runNativeCompaction()` entry point that reuses the
 * exact same compaction pipeline (persist expandable refs → compact → telemetry)
 * but attributes the result to the native runtime (`runtimeKind: 'native_hook'`).
 *
 * Callers (e.g. the native `Stop` hook handler) buffer `ToolCallRecord`s per
 * session and flush them here at a turn boundary.
 */
import type { PluginContext } from '../plugin-context.js';
import type { ToolCallRecord } from '../types.js';
import { persistCompactionTelemetry } from '../compaction-metric-writer.js';
import type { CompactionClientKind } from '../compaction-metric-writer.js';
import { getLogger } from '../logger.js';
import {
  runCompactionPipeline,
  type CompactionPipelineAttribution,
} from './messages-transform-pipeline.js';

export interface NativeCompactionResult {
  status: 'compressed' | 'skipped_under_budget' | 'failed' | 'no_records';
  result?: {
    compactedParts: number;
    skippedParts: number;
    tokensSaved: number;
    savedPercent: number;
  };
}

/**
 * Run the shared compaction pipeline for a batch of native tool-call records.
 *
 * @param ctx          The active plugin context (must include contextCompactor + database).
 * @param records      Tool-call records accumulated during the native turn.
 * @param sessionId    The native session id.
 * @param clientKind   Host attribution ('codex' for Codex, 'unknown' for others).
 * @returns Summary of the compaction outcome.
 */
export async function runNativeCompaction(
  ctx: PluginContext,
  records: ToolCallRecord[],
  sessionId: string,
  clientKind: CompactionClientKind = 'unknown',
): Promise<NativeCompactionResult> {
  if (!ctx.config.compactor?.enabled || records.length === 0) {
    return { status: 'no_records' };
  }

  const pool = ctx.database.getPool();
  const createdAt = new Date().toISOString();
  const attribution: CompactionPipelineAttribution = {
    clientKind,
    runtimeKind: 'native_hook',
  };

  try {
    const outcome = await runCompactionPipeline(ctx, pool, records);

    persistCompactionTelemetry(pool, {
      sessionId,
      projectId: ctx.directory,
      clientKind: attribution.clientKind,
      runtimeKind: attribution.runtimeKind,
      totalToolParts: records.length,
      compactedParts: outcome.compactedParts,
      skippedParts: outcome.skippedParts,
      eligibleParts: outcome.eligibleParts,
      persistedParts: outcome.persistedParts,
      beforeChars: outcome.beforeChars,
      afterChars: outcome.afterChars,
      beforeTokens: outcome.beforeTokens,
      afterTokens: outcome.afterTokens,
      tokensSaved: outcome.tokensSaved,
      savedPercent: outcome.savedPercent,
      semanticSignalCountPreserved: outcome.semanticSignalCountPreserved,
      contextBriefChars: 0,
      discardMarkerPresent: 0,
      status: outcome.status,
      failureStage: outcome.failureStage,
      failureCode: outcome.failureCode,
      failureMessage: outcome.failureMessage,
      createdAt,
    });

    return {
      status: outcome.status,
      result: {
        compactedParts: outcome.compactedParts,
        skippedParts: outcome.skippedParts,
        tokensSaved: outcome.tokensSaved,
        savedPercent: outcome.savedPercent,
      },
    };
  } catch (error) {
    getLogger().error(`Native compaction failed: ${String(error)}`);
    persistCompactionTelemetry(pool, {
      sessionId,
      projectId: ctx.directory,
      clientKind: attribution.clientKind,
      runtimeKind: attribution.runtimeKind,
      totalToolParts: records.length,
      compactedParts: 0,
      skippedParts: 0,
      eligibleParts: 0,
      persistedParts: 0,
      beforeChars: 0,
      afterChars: 0,
      beforeTokens: 0,
      afterTokens: 0,
      tokensSaved: 0,
      savedPercent: 0,
      semanticSignalCountPreserved: 0,
      contextBriefChars: 0,
      discardMarkerPresent: 0,
      status: 'failed',
      failureStage: 'native_compactor',
      failureCode: error instanceof Error && error.name
        ? error.name.slice(0, 80)
        : 'unknown_error',
      failureMessage: (error instanceof Error ? error.message : String(error))
        .replace(/\s+/g, ' ').trim().slice(0, 500),
      createdAt,
    });
    return { status: 'failed' };
  }
}

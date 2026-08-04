/**
 * Shared compaction pipeline — used by both the OpenCode `messages.transform`
 * hook and the native-runtime compaction trigger.
 *
 * Extracted from `messages-transform.ts` so the native path (Claude Code, Codex)
 * can reuse the exact same persist → compact → telemetry pipeline without
 * duplicating ~100 lines of logic. The only difference between callers is the
 * attribution (`clientKind` / `runtimeKind`) stamped on the telemetry row.
 */
import type { PluginContext } from '../plugin-context.js';
import type { ToolCallRecord } from '../types.js';
import type { CompactableMessage } from '../context-compactor.js';
import { estimateTokens } from '../token-bucket-analyzer.js';
import { getLogger } from '../logger.js';
import { storeItem, type CacheKind } from '../context-cache-store.js';
import type {
  CompactionClientKind,
  CompactionRuntimeKind,
  CompactionStatus,
} from '../compaction-metric-writer.js';

export interface CompactionPipelineAttribution {
  clientKind: CompactionClientKind;
  runtimeKind: CompactionRuntimeKind;
}

export interface CompactionPipelineResult {
  status: CompactionStatus;
  compactedParts: number;
  skippedParts: number;
  eligibleParts: number;
  persistedParts: number;
  beforeChars: number;
  afterChars: number;
  beforeTokens: number;
  afterTokens: number;
  tokensSaved: number;
  savedPercent: number;
  semanticSignalCountPreserved: number;
  failureStage?: string;
  failureCode?: string;
  failureMessage?: string;
  /** Raw records that must survive for a later native compaction pass. */
  retainedRecords: ToolCallRecord[];
}

interface PersistenceResult {
  recordsForCompaction: ToolCallRecord[];
  failedRecords: ToolCallRecord[];
  eligibleParts: number;
  persistedParts: number;
  failedParts: number;
  failure?: unknown;
  failureCode?: 'cache_disabled' | 'cache_write_failed' | 'partial_cache_write_failed';
}

/**
 * Run the full compaction pipeline on a batch of tool-call records.
 *
 * Steps:
 * 1. Persist expandable refs for eligible records (so compacted TOOL_REF
 *    tokens can be recovered on demand).
 * 2. Invoke `ContextCompactor.compact()` on the surviving records.
 * 3. Classify the outcome and surface any failure diagnostics.
 *
 * Telemetry persistence is the caller's responsibility — this function returns
 * the structured result so callers can stamp their own attribution before
 * writing the metric row.
 */
export async function runCompactionPipeline(
  ctx: PluginContext,
  pool: ReturnType<PluginContext['database']['getPool']>,
  records: ToolCallRecord[],
  messages?: CompactableMessage[],
): Promise<CompactionPipelineResult> {
  const persistence = await persistExpandableRecords(ctx, pool, records);

  if (persistence.failedParts > 0) {
    getLogger().warn(
      'Some compaction candidates could not be stored for recovery: '
      + `eligible=${persistence.eligibleParts} persisted=${persistence.persistedParts} `
      + `failed=${persistence.failedParts} code=${persistence.failureCode ?? 'unknown'}`,
    );
  }

  const compactOutput = ctx.contextCompactor.compact(
    persistence.recordsForCompaction,
    undefined,
    messages,
  );
  const result = compactOutput.result;

  const status: CompactionStatus = result.compactedParts > 0
    ? 'compressed'
    : persistence.eligibleParts > 0 && persistence.persistedParts === 0
      ? 'failed'
      : 'skipped_under_budget';

  const quality = ctx.contextCompactor.getLastQuality();
  const qualityRejected = result.compactedParts === 0
    && result.skippedParts > 0
    && quality?.safe === false;

  const failureStage = persistence.failedParts > 0
    ? 'context_cache'
    : qualityRejected ? 'quality_gate' : undefined;
  const failureCode = persistence.failureCode
    ?? (qualityRejected ? 'quality_rejected' : undefined);
  const failureMessage = diagnosticMessage(persistence.failure)
    ?? (qualityRejected
      ? `quality_score=${quality.qualityScore.toFixed(3)} threshold=0.600`
      : undefined);

  return {
    status,
    compactedParts: result.compactedParts,
    skippedParts: result.skippedParts + persistence.failedParts,
    eligibleParts: persistence.eligibleParts,
    persistedParts: persistence.persistedParts,
    beforeChars: result.beforeChars,
    afterChars: result.afterChars,
    beforeTokens: result.beforeTokens,
    afterTokens: result.afterTokens,
    tokensSaved: result.tokensSaved,
    savedPercent: result.savedPercent,
    semanticSignalCountPreserved: result.semanticSignalCountPreserved,
    failureStage,
    failureCode,
    failureMessage,
    retainedRecords: [
      ...compactOutput.retainedRecords,
      ...persistence.failedRecords,
    ],
  };
}

// Re-exported so messages-transform.ts can delegate here without duplicating.
export { persistExpandableRecords };

async function persistExpandableRecords(
  ctx: PluginContext,
  pool: ReturnType<PluginContext['database']['getPool']>,
  records: ToolCallRecord[],
): Promise<PersistenceResult> {
  const candidates = records.filter((record) => {
    const source = record.error ?? record.output ?? '';
    return source.trim().length > 0
      && ctx.contextCompactor.createExpandableRef(record).length < source.length;
  });
  const candidateSet = new Set(candidates);
  const ineligible = records.filter((record) => !candidateSet.has(record));

  if (candidates.length === 0) {
    return {
      recordsForCompaction: records,
      failedRecords: [],
      eligibleParts: 0,
      persistedParts: 0,
      failedParts: 0,
    };
  }
  if (ctx.config?.contextCache?.enabled === false) {
    return {
      recordsForCompaction: ineligible,
      failedRecords: candidates,
      eligibleParts: candidates.length,
      persistedParts: 0,
      failedParts: candidates.length,
      failure: new Error('tool compaction requires context cache for recoverable TOOL_REF output'),
      failureCode: 'cache_disabled',
    };
  }

  const writes = await Promise.allSettled(candidates.map(async (record) => {
    const source = record.error ?? record.output ?? '';
    const refId = ctx.contextCompactor.getExpandableRefId(record);
    await storeItem(pool, {
      sessionId: record.sessionId,
      displayId: refId,
      kind: cacheKind(record),
      createdAt: record.timestamp,
      summary: summarizeRecord(record, source),
      content: source,
      metadata: {
        source: 'tool_compaction',
        tool: record.tool,
        filePath: record.filePath,
        messageId: record.messageId,
        partId: record.partId,
        toolCallId: record.toolCallId,
      },
      tokens: estimateTokens(source),
    }, ctx.redactor);
    return record;
  }));

  const persisted: ToolCallRecord[] = [];
  const failedRecords: ToolCallRecord[] = [];
  let firstFailure: unknown;
  for (const [index, write] of writes.entries()) {
    if (write.status === 'fulfilled') persisted.push(write.value);
    else {
      failedRecords.push(candidates[index]);
      firstFailure ??= write.reason;
    }
  }
  const failedParts = candidates.length - persisted.length;
  return {
    recordsForCompaction: [...ineligible, ...persisted],
    failedRecords,
    eligibleParts: candidates.length,
    persistedParts: persisted.length,
    failedParts,
    failure: firstFailure,
    failureCode: failedParts === 0
      ? undefined
      : persisted.length === 0 ? 'cache_write_failed' : 'partial_cache_write_failed',
  };
}

function cacheKind(record: ToolCallRecord): CacheKind {
  if (record.error) return 'error';
  if (record.tool === 'read' && record.filePath) return 'file_read';
  return 'tool_output';
}

function summarizeRecord(record: ToolCallRecord, source: string): string {
  const subject = record.filePath ?? String(record.args.command ?? record.tool);
  const summary = source.replace(/\s+/g, ' ').trim().slice(0, 100);
  return `${record.tool} ${subject}: ${summary}`.slice(0, 180);
}

function diagnosticMessage(error: unknown): string | undefined {
  if (!error) return undefined;
  const rawMessage = error instanceof Error ? error.message : String(error ?? 'unknown error');
  return rawMessage.replace(/\s+/g, ' ').trim().slice(0, 500);
}

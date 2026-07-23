import type { PluginContext } from '../plugin-context.js';
import type { ToolCallRecord } from '../types.js';
import { extractTextParts, rememberUserTurn } from './reentry-source-only.js';
import { persistCompactionTelemetry } from '../compaction-metric-writer.js';
import { getLogger, withLogContext } from '../logger.js';
import { isAlreadyCompacted } from '../compaction-utils.js';
import type { GovernorMessage, GovernorPart } from '../context-governor.js';
import { storeItem, type CacheKind } from '../context-cache-store.js';
import { estimateTokens } from '../token-bucket-analyzer.js';

interface TransformToolState {
  status: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  time?: { start?: number; end?: number; compacted?: number };
}

interface TransformPart extends GovernorPart {
  id?: string;
  messageID?: string;
  callID?: string;
  toolCallId?: string;
  type: string;
  text?: string;
  tool?: string;
  state?: TransformToolState;
  sessionID?: string;
}

interface TransformMessage extends GovernorMessage {
  info?: { role?: string; sessionID?: string; id?: string };
  parts?: TransformPart[];
}

interface ExpandablePersistenceResult {
  recordsForCompaction: ToolCallRecord[];
  eligibleParts: number;
  persistedParts: number;
  failedParts: number;
  failure?: unknown;
  failureCode?: 'cache_disabled' | 'cache_write_failed' | 'partial_cache_write_failed';
}

export function createMessagesTransformHook(ctx: PluginContext) {
  return async (_input: unknown, output: { messages: TransformMessage[] }) => {
    const observedSession = latestSessionId(output.messages)
      ?? ctx.state.currentSessionId ?? undefined;
    return withLogContext({ projectId: ctx.directory, sessionId: observedSession }, async () => {
    try {
      const messages = output.messages;
      if (!messages || messages.length === 0) return;

      const records: ToolCallRecord[] = [];
      const fallbackSid = ctx.state.currentSessionId ?? 'unknown';
      const latestUserIndex = findLatestUserMessageIndex(messages);

      for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
        const msg = messages[messageIndex];
        if (msg.info?.role === 'user') {
          const userText = extractTextParts(msg.parts ?? []);
          if (userText) rememberUserTurn(ctx.state, msg.info.sessionID ?? fallbackSid, userText);
          continue;
        }

        if (msg.info?.role !== 'assistant') continue;
        if (!isCompletedPriorTurn(messageIndex, latestUserIndex)) continue;

        const parts = msg.parts ?? [];
        for (const part of parts) {
          if (part.type !== 'tool') continue;
          const state = part.state;
          if (!state) continue;
          if (state.status !== 'completed' && state.status !== 'error') continue;
          if (isAlreadyCompacted(part)) continue;

          const timestamp = state.time?.start;
          if (!Number.isFinite(timestamp)) continue;

          const args = state.input ?? {};
          const toolOutput = typeof state.output === 'string' ? state.output : '';
          const error = state.status === 'error' ? state.error : undefined;
          const sessionId = part.sessionID ?? msg.info?.sessionID ?? fallbackSid;
          const filePath = (args.filePath as string) ?? (args.path as string) ?? undefined;

          records.push({
            tool: part.tool ?? 'unknown',
            args,
            output: toolOutput,
            error,
            timestamp: timestamp as number,
            sessionId,
            messageId: part.messageID ?? msg.info?.id,
            partId: part.id,
            toolCallId: part.callID ?? part.toolCallId,
            filePath,
          });
        }
      }

      auditGovernor(ctx, messages);

      if (records.length === 0) return;

      const sessionId = ctx.state.currentSessionId ?? 'unknown';
      const pool = ctx.database.getPool();
      const createdAt = new Date().toISOString();

      try {
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
        const status = result.compactedParts > 0
          ? 'compressed'
          : persistence.eligibleParts > 0 && persistence.persistedParts === 0
            ? 'failed'
            : 'skipped_under_budget';
        const failure = persistence.failedParts > 0
          ? diagnosticFailure(ctx, persistence.failure)
          : undefined;
        const quality = ctx.contextCompactor.getLastQuality();
        const qualityRejected = result.compactedParts === 0
          && result.skippedParts > 0
          && quality?.safe === false;
        const failureStage = persistence.failedParts > 0
          ? 'context_cache'
          : qualityRejected ? 'quality_gate' : undefined;
        const failureCode = persistence.failureCode
          ?? (qualityRejected ? 'quality_rejected' : undefined);
        const failureMessage = failure?.message
          ?? (qualityRejected
            ? `quality_score=${quality.qualityScore.toFixed(3)} threshold=0.600`
            : undefined);
        persistCompactionTelemetry(pool, {
          sessionId,
          projectId: ctx.directory,
          clientKind: 'opencode',
          runtimeKind: 'plugin',
          totalToolParts: records.length,
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
          contextBriefChars: 0,
          discardMarkerPresent: 0,
          status,
          failureStage,
          failureCode,
          failureMessage,
          createdAt,
        });
      } catch (compactError) {
        getLogger().error(`Compaction failed: ${String(compactError)}`);
        const snapshot = recordSnapshot(records);
        const failure = diagnosticFailure(ctx, compactError);
        persistCompactionTelemetry(pool, {
          sessionId,
          projectId: ctx.directory,
          clientKind: 'opencode',
          runtimeKind: 'plugin',
          totalToolParts: records.length,
          compactedParts: 0,
          skippedParts: 0,
          eligibleParts: 0,
          persistedParts: 0,
          beforeChars: snapshot.chars,
          afterChars: snapshot.chars,
          beforeTokens: snapshot.tokens,
          afterTokens: snapshot.tokens,
          tokensSaved: 0,
          savedPercent: 0,
          semanticSignalCountPreserved: 0,
          contextBriefChars: 0,
          discardMarkerPresent: 0,
          status: 'failed',
          failureStage: 'compactor',
          failureCode: failure.code,
          failureMessage: failure.message,
          createdAt,
        });
      }
    } catch (error) {
      getLogger().error(`messages.transform hook failed: ${String(error)}`);
    }
    });
  };
}

function latestSessionId(messages: readonly TransformMessage[] | undefined): string | undefined {
  if (!messages) return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const sessionId = messages[index].info?.sessionID;
    if (sessionId) return sessionId;
  }
  return undefined;
}


function findLatestUserMessageIndex(messages: TransformMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].info?.role === 'user') return index;
  }
  return -1;
}

function isCompletedPriorTurn(messageIndex: number, latestUserIndex: number): boolean {
  return latestUserIndex >= 0 && messageIndex < latestUserIndex;
}

function auditGovernor(ctx: PluginContext, messages: TransformMessage[]): void {
  if (!ctx.contextGovernor || ctx.config.contextGovernor?.enabled === false) return;
  const result = ctx.contextGovernor.govern(cloneForGovernorAudit(messages));
  ctx.lastCompileResult = result.compileResult ?? null;
  getLogger().info('Context governor audit', {
    eventType: 'context_governor',
    profile: result.decision.profile,
    thresholds: Object.values(result.thresholds).join('/'),
    reason: result.decision.reason,
    observedAt: result.observedAt,
    outcome: result.decision.action,
  });
}

async function persistExpandableRecords(
  ctx: PluginContext,
  pool: ReturnType<PluginContext['database']['getPool']>,
  records: ToolCallRecord[],
): Promise<ExpandablePersistenceResult> {
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
      eligibleParts: 0,
      persistedParts: 0,
      failedParts: 0,
    };
  }
  if (ctx.config?.contextCache?.enabled === false) {
    return {
      recordsForCompaction: ineligible,
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
  let firstFailure: unknown;
  for (const write of writes) {
    if (write.status === 'fulfilled') persisted.push(write.value);
    else firstFailure ??= write.reason;
  }
  const failedParts = candidates.length - persisted.length;
  return {
    recordsForCompaction: [...ineligible, ...persisted],
    eligibleParts: candidates.length,
    persistedParts: persisted.length,
    failedParts,
    failure: firstFailure,
    failureCode: failedParts === 0
      ? undefined
      : persisted.length === 0 ? 'cache_write_failed' : 'partial_cache_write_failed',
  };
}

function diagnosticFailure(ctx: PluginContext, error: unknown): { code: string; message: string } {
  const code = error instanceof Error && error.name ? error.name : 'unknown_error';
  const rawMessage = error instanceof Error ? error.message : String(error ?? 'unknown error');
  const redactedMessage = ctx.redactor
    ? ctx.redactor.redact(rawMessage).text
    : rawMessage;
  return {
    code: code.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80),
    message: redactedMessage.replace(/\s+/g, ' ').trim().slice(0, 500),
  };
}

function recordSnapshot(records: ToolCallRecord[]): { chars: number; tokens: number } {
  const text = records.map((record) => JSON.stringify({
    tool: record.tool,
    args: record.args,
    output: record.output,
    error: record.error,
  })).join('\n');
  return { chars: text.length, tokens: estimateTokens(text) };
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

function cloneForGovernorAudit(messages: TransformMessage[]): TransformMessage[] {
  return messages.map((message) => ({
    ...message,
    info: message.info ? { ...message.info } : undefined,
    parts: message.parts?.map((part) => ({
      ...part,
      state: part.state
        ? {
          ...part.state,
          input: part.state.input ? { ...part.state.input } : undefined,
          time: part.state.time ? { ...part.state.time } : undefined,
        }
        : undefined,
    })),
  }));
}

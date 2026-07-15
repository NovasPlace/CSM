import type { PluginContext } from '../plugin-context.js';
import type { ToolCallRecord } from '../types.js';
import { extractTextParts, rememberUserTurn } from './reentry-source-only.js';
import { persistCompactionTelemetry } from '../compaction-metric-writer.js';
import { getLogger } from '../logger.js';
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

export function createMessagesTransformHook(ctx: PluginContext) {
  return async (_input: unknown, output: { messages: TransformMessage[] }) => {
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
        await persistExpandableRecords(ctx, pool, records);
        const compactOutput = ctx.contextCompactor.compact(records, undefined, messages);
        const result = compactOutput.result;
        const status: 'compressed' | 'skipped_under_budget' =
          result.compactedParts > 0 ? 'compressed' : 'skipped_under_budget';
        persistCompactionTelemetry(pool, {
          sessionId,
          totalToolParts: result.totalToolParts,
          compactedParts: result.compactedParts,
          skippedParts: result.skippedParts,
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
          createdAt,
        });
      } catch (compactError) {
        getLogger().error(`Compaction failed: ${String(compactError)}`);
        persistCompactionTelemetry(pool, {
          sessionId,
          totalToolParts: records.length,
          compactedParts: 0,
          skippedParts: 0,
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
          createdAt,
        });
      }
    } catch (error) {
      getLogger().error(`messages.transform hook failed: ${String(error)}`);
    }
  };
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
): Promise<void> {
  if (ctx.config?.contextCache?.enabled === false) {
    throw new Error('tool compaction requires context cache for recoverable TOOL_REF output');
  }
  const candidates = records.filter((record) => {
    const source = record.error ?? record.output ?? '';
    return source.trim().length > 0
      && ctx.contextCompactor.createExpandableRef(record).length < source.length;
  });
  await Promise.all(candidates.map(async (record) => {
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
  }));
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

import type { PluginContext } from '../plugin-context.js';
import type { ToolCallRecord } from '../types.js';
import { extractTextParts, rememberUserTurn } from './reentry-source-only.js';
import { persistCompactionTelemetry } from '../compaction-metric-writer.js';
import { getLogger, withLogContext } from '../logger.js';
import { isAlreadyCompacted } from '../compaction-utils.js';
import type { GovernorMessage, GovernorPart } from '../context-governor.js';
import { runCompactionPipeline } from './messages-transform-pipeline.js';
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
        const outcome = await runCompactionPipeline(ctx, pool, records, messages);
        persistCompactionTelemetry(pool, {
          sessionId,
          projectId: ctx.directory,
          clientKind: 'opencode',
          runtimeKind: 'plugin',
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
      } catch (compactError) {
        getLogger().error(`Compaction failed: ${String(compactError)}`);
        const snapshot = recordSnapshot(records);
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
          failureCode: compactError instanceof Error && compactError.name
            ? compactError.name.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80)
            : 'unknown_error',
          failureMessage: (compactError instanceof Error ? compactError.message : String(compactError))
            .replace(/\s+/g, ' ').trim().slice(0, 500),
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

function recordSnapshot(records: ToolCallRecord[]): { chars: number; tokens: number } {
  const text = records.map((record) => JSON.stringify({
    tool: record.tool,
    args: record.args,
    output: record.output,
    error: record.error,
  })).join('\n');
  return { chars: text.length, tokens: estimateTokens(text) };
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

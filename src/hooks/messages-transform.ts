import type { PluginContext } from '../plugin-context.js';
import type { ToolCallRecord } from '../types.js';
import { extractTextParts, rememberUserTurn } from './reentry-source-only.js';
import { persistCompactionTelemetry } from '../compaction-metric-writer.js';
import { getLogger } from '../logger.js';

interface TransformToolState {
  status: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  time?: { start?: number; end?: number };
}

interface TransformPart {
  type: string;
  text?: string;
  tool?: string;
  state?: TransformToolState;
  sessionID?: string;
}

interface TransformMessage {
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

      for (const msg of messages) {
        if (msg.info?.role === 'user') {
          const userText = extractTextParts(msg.parts ?? []);
          if (userText) rememberUserTurn(ctx.state, msg.info.sessionID ?? fallbackSid, userText);
          continue;
        }

        if (msg.info?.role !== 'assistant') continue;
        const parts = msg.parts ?? [];
        for (const part of parts) {
          if (part.type !== 'tool') continue;
          const state = part.state;
          if (!state) continue;
          if (state.status !== 'completed' && state.status !== 'error') continue;

          const args = state.input ?? {};
          const toolOutput = typeof state.output === 'string' ? state.output : '';
          const error = state.status === 'error' ? state.error : undefined;
          const timestamp = state.time?.start ?? Date.now();
          const sessionId = part.sessionID ?? msg.info?.sessionID ?? fallbackSid;
          const filePath = (args.filePath as string) ?? (args.path as string) ?? undefined;

          records.push({
            tool: part.tool ?? 'unknown',
            args,
            output: toolOutput,
            error,
            timestamp,
            sessionId,
            filePath,
          });
        }
      }

      if (records.length === 0) return;

      const sessionId = ctx.state.currentSessionId ?? 'unknown';
      const pool = ctx.database.getPool();
      const createdAt = new Date().toISOString();

      try {
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

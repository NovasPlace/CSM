import type { PluginContext } from '../plugin-context.js';
import type { ToolCallRecord } from '../types.js';

interface TransformToolState {
  status: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  time?: { start?: number; end?: number };
}

interface TransformPart {
  type: string;
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

      ctx.contextCompactor.compact(records, undefined, messages);
    } catch (error) {
      console.error('[CrossSessionMemory] messages.transform hook failed:', error);
    }
  };
}
import type { PluginContext } from '../plugin-context.js';
import type { ToolCallRecord } from '../types.js';
import { ensureProjectDocsInitialized } from './auto-docs.js';
import { autoDistill, logToolUsage } from './tool-execute-memory.js';

/**
 * tool.execute.before — Fires before any tool call.
 * - Loop detection + auto-lesson
 * - Phase 4B risky_edit auto-checkpoint
 */
export function createToolExecuteBeforeHook(ctx: PluginContext) {
  return async (input: any, output: any) => {
    try {
      ctx.syncActiveSession(input.sessionID);
      const result = ctx.loopDetector.recordCall(input.tool, output.args);

      // Lesson trigger warnings — check BEFORE tool executes
      try {
        await ctx.lessonTriggers.refresh();
        const warning = ctx.lessonTriggers.buildInjection(input.tool, output.args ?? {});
        if (warning) {
          console.warn(`[LessonTriggers] Matched lesson for tool "${input.tool}":\n${warning}`);
        }
      } catch { /* lesson trigger check non-critical */ }

      // Phase 4B — Risky edit auto-checkpoint
      const autoConfig = ctx.config.checkpoint.auto;
      const sid = ctx.state.currentSessionId;
      if (autoConfig?.enabled && sid) {
        const riskyPatterns = autoConfig.riskyEditToolPatterns ?? [];
        const isRisky = riskyPatterns.some((p: string) =>
          input.tool === p || input.tool.includes(p),
        );
        if (isRisky) {
          const filePath =
            (output.args?.filePath as string) ??
            (output.args?.path as string) ??
            undefined;
          await ctx.autoCheckpoint(sid, 'risky_edit', {
            tool: input.tool,
            filePath,
          }).catch((e: unknown) =>
            console.error('[CrossSessionMemory] Auto-checkpoint (risky_edit) failed:', e),
          );
        }
      }

      if (result.loop) {
        console.warn('[CrossSessionMemory] LOOP DETECTED:', result.mayday);
        await ctx.memoryManager.saveMemory({
          content: `Avoid repeating ${input.tool} with identical arguments — it causes loops. Use a different tool or change the approach.`,
          type: 'lesson',
          importance: 0.75,
          emotion: 'frustration',
          confidence: 0.9,
          source: 'lesson',
          tags: ['auto-lesson', 'loop-detected', input.tool, `tool:${input.tool}`],
          metadata: {
            tool: input.tool,
            callCount: result.callCount,
            mayday: result.mayday,
            triggers: { tools: [input.tool] },
          },
          sessionId: sid ?? undefined,
        });
        ctx.loopDetector.clearHistory();
      }
    } catch (error) {
      console.error('[CrossSessionMemory] Loop detection error:', error);
    }
  };
}

/**
 * tool.execute.after — Fires after any tool call.
 * - Records tool calls for distiller
 * - Auto-distills when buffer reaches threshold
 * - Logs tool usage + file operations + commands as memories
 */
export function createToolExecuteAfterHook(ctx: PluginContext) {
  return async (input: any, output: any) => {
    try {
      ctx.syncActiveSession(input.sessionID);
      const sid = ctx.state.currentSessionId;

      if (ctx.directory && !ctx.state._docsInitialized) {
        ctx.state._docsInitialized = true;
        ensureProjectDocsInitialized(ctx.directory).catch(() => {});
      }

      // Record tool call for distiller
      if (ctx.config.distiller.enabled && sid) {
        const filePath =
          (input.args?.filePath as string) ??
          (input.args?.path as string) ??
          undefined;

        const record: ToolCallRecord = {
          tool: input.tool,
          args: input.args ?? {},
          output: typeof output.output === 'string'
            ? output.output.substring(0, 2000)
            : JSON.stringify(output.output ?? '').substring(0, 2000),
          error: output.metadata?.error as string | undefined,
          exitCode: output.metadata?.exitCode as number | undefined,
          timestamp: Date.now(),
          sessionId: sid,
          filePath,
        };

        ctx.toolDistiller.record(record);

        // Work journal — live capture of tool calls
        if (ctx.config.workJournal?.enabled) {
          ctx.workJournal.recordToolCall({
            sessionId: sid,
            projectId: ctx.directory,
            toolName: input.tool as string,
            args: input.args ?? {},
            output: typeof output.output === 'string'
              ? output.output.substring(0, 2000)
              : JSON.stringify(output.output ?? '').substring(0, 2000),
            error: output.metadata?.error as string | undefined,
            exitCode: output.metadata?.exitCode as number | undefined,
          });
          ctx.workJournal.updateTokenSnapshot(output.metadata?.tokenCount ?? 0);
        }

        // Auto-distill when buffer reaches threshold
        if (ctx.toolDistiller.bufferLength >= 10) {
          await autoDistill(ctx, sid);
        }
      }

      // Log tool usage as episodic memories
      if (ctx.config.logToolUsage) {
        await logToolUsage(ctx, input, output, sid);
      }
    } catch (error) {
      console.error('[CrossSessionMemory] Tool tracking error:', error);
    }
  };
}

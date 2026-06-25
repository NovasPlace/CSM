import type { PluginContext } from '../plugin-context.js';
import type { ToolCallRecord } from '../types.js';
import { queueDocUpdate, flushDocUpdates } from './auto-docs.js';

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
          content: `LESSON: Detected loop - ${input.tool} called ${result.callCount} times with identical arguments. Need to change approach.`,
          type: 'lesson',
          importance: 0.75,
          emotion: 'frustration',
          confidence: 0.9,
          source: 'lesson',
          tags: ['auto-lesson', 'loop-detected', input.tool],
          metadata: { tool: input.tool, callCount: result.callCount, mayday: result.mayday },
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

/** Auto-distill tool calls and save summaries + memories. */
async function autoDistill(ctx: PluginContext, sid: string): Promise<void> {
  const summary = ctx.toolDistiller.distill();
  if (summary.groups.length === 0) return;

  const pool = ctx.database.getPool();
  await pool.query(
    `INSERT INTO distilled_summaries (id, session_id, groups, compressed, total_calls_summarized)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      summary.id,
      sid,
      JSON.stringify(summary.groups),
      summary.compressed,
      summary.totalCallsSummarized,
    ],
  );

  if (ctx.config.distiller.autoSaveAsMemory) {
    await ctx.memoryExtractor.extractFromDistilledSummaries(sid, sid, summary);
  }
  await ctx.refreshActiveContext(sid);
}

/** Log significant tool usage as episodic memories. */
async function logToolUsage(
  ctx: PluginContext,
  input: any,
  output: any,
  sid: string | null,
): Promise<void> {
  const significantTools = [
    'read', 'write', 'edit', 'glob', 'grep', 'bash', 'task',
    'memory_save', 'memory_search', 'memory_lesson',
  ];

  if (significantTools.includes(input.tool)) {
    await ctx.memoryManager.saveMemory({
      content: `Tool used: ${input.tool}`,
      type: 'episodic',
      importance: 0.2,
      source: 'auto',
      tags: ['tool-usage', input.tool],
      metadata: {
        tool: input.tool,
        args: input.args,
        outputPreview: typeof output.output === 'string'
          ? output.output.substring(0, 200)
          : 'non-string output',
      },
      sessionId: sid ?? undefined,
    });
  }

  // Log file operations + queue doc updates
  if (input.tool === 'write' || input.tool === 'edit') {
    const filePath = input.args?.filePath ?? input.args?.path ?? 'unknown';
    queueDocUpdate(filePath, input.tool === 'write' ? 'write' : 'edit');
    await ctx.memoryManager.saveMemory({
      content: `File ${input.tool === 'write' ? 'written' : 'edited'}: ${filePath}`,
      type: 'episodic',
      importance: 0.4,
      source: 'auto',
      tags: ['file-operation', input.tool],
      metadata: { operation: input.tool, filePath },
      sessionId: sid ?? undefined,
    });
  }

  // Log commands
  if (ctx.config.logCommands && input.tool === 'bash') {
    const command = input.args?.command ?? 'unknown';
    await ctx.memoryManager.saveMemory({
      content: `Command executed: ${command.substring(0, 200)}`,
      type: 'procedural',
      importance: 0.3,
      source: 'auto',
      tags: ['command', 'procedural'],
      metadata: { command: command.substring(0, 500), exitCode: output.metadata?.exitCode },
      sessionId: sid ?? undefined,
    });
  }
}

import type { PluginContext } from '../plugin-context.js';
import { cacheToolErrorSignal } from '../context-cache-signals.js';
import type { ToolCallRecord } from '../types.js';
import { ensureProjectDocsInitialized } from './auto-docs.js';
import { autoDistill, logToolUsage } from './tool-execute-memory.js';

export function createToolExecuteBeforeHook(ctx: PluginContext) {
  return async (input: any, output: any) => {
    try {
      ctx.syncActiveSession(input.sessionID);
      const result = ctx.loopDetector.recordCall(input.tool, output.args);
      await injectLessonWarning(ctx, input, output);
      await maybeCreateRiskyEditCheckpoint(ctx, input, output);
      if (result.loop) await storeLoopLesson(ctx, input.tool, result.callCount, result.mayday);
    } catch (error) {
      console.error('[CrossSessionMemory] Loop detection error:', error);
    }
  };
}

export function createToolExecuteAfterHook(ctx: PluginContext) {
  return async (input: any, output: any) => {
    try {
      ctx.syncActiveSession(input.sessionID);
      const sid = ctx.state.currentSessionId;
      await ensureDocsInitialized(ctx);

      const toolOutput = summarizeToolOutput(output.output);
      const tokenSnapshot = output.metadata?.tokenCount ?? 0;
      recordWorkJournal(ctx, input, output, sid, toolOutput, tokenSnapshot);
      await recordDistilledToolCall(ctx, input, output, sid, toolOutput);
      await recordContinuitySignals(ctx, input, output, sid, toolOutput);

      if (ctx.config.logToolUsage) {
        await logToolUsage(ctx, input, output, sid);
      }
    } catch (error) {
      console.error('[CrossSessionMemory] Tool tracking error:', error);
    }
  };
}

async function injectLessonWarning(ctx: PluginContext, input: any, output: any): Promise<void> {
  try {
    await ctx.lessonTriggers.refresh();
    const warning = ctx.lessonTriggers.buildInjection(input.tool, output.args ?? {});
    if (warning) console.warn(`[LessonTriggers] Matched lesson for tool "${input.tool}":\n${warning}`);
  } catch { /* lesson refresh failed, skip */ }
}

async function maybeCreateRiskyEditCheckpoint(
  ctx: PluginContext,
  input: any,
  output: any,
): Promise<void> {
  const sid = ctx.state.currentSessionId;
  const autoConfig = ctx.config.checkpoint.auto;
  if (!autoConfig?.enabled || !sid) return;

  const riskyPatterns = autoConfig.riskyEditToolPatterns ?? [];
  const isRisky = riskyPatterns.some((pattern: string) => input.tool === pattern || input.tool.includes(pattern));
  if (!isRisky) return;

  const filePath = (output.args?.filePath as string) ?? (output.args?.path as string) ?? undefined;
  await ctx.autoCheckpoint(sid, 'risky_edit', { tool: input.tool, filePath }).catch((error: unknown) =>
    console.error('[CrossSessionMemory] Auto-checkpoint (risky_edit) failed:', error),
  );
}

async function storeLoopLesson(
  ctx: PluginContext,
  tool: string,
  callCount: number,
  mayday?: string,
): Promise<void> {
  const sid = ctx.state.currentSessionId;
  await ctx.memoryManager.saveMemory({
    content: `Avoid repeating ${tool} with identical arguments - it causes loops. Use a different tool or change the approach.`,
    type: 'lesson',
    importance: 0.75,
    emotion: 'frustration',
    confidence: 0.9,
    source: 'lesson',
    tags: ['auto-lesson', 'loop-detected', tool, `tool:${tool}`],
    metadata: { tool, callCount, mayday, triggers: { tools: [tool] } },
    sessionId: sid ?? undefined,
  });
  ctx.loopDetector.clearHistory();
}

async function ensureDocsInitialized(ctx: PluginContext): Promise<void> {
  if (!ctx.directory || ctx.state._docsInitialized) return;
  ctx.state._docsInitialized = true;
  await ensureProjectDocsInitialized(ctx.directory).catch(() => {});
}

function summarizeToolOutput(output: unknown): string {
  if (typeof output === 'string') return output.substring(0, 2000);
  return JSON.stringify(output ?? '').substring(0, 2000);
}

function recordWorkJournal(
  ctx: PluginContext,
  input: any,
  output: any,
  sid: string | null,
  toolOutput: string,
  tokenSnapshot: number,
): void {
  if (!ctx.config.workJournal?.enabled || !sid) return;
  ctx.workJournal.recordToolCall({
    sessionId: sid,
    projectId: ctx.directory,
    toolName: input.tool as string,
    args: input.args ?? {},
    output: toolOutput,
    error: output.metadata?.error as string | undefined,
    exitCode: output.metadata?.exitCode as number | undefined,
    tokenSnapshot,
  });
  ctx.workJournal.updateTokenSnapshot(tokenSnapshot);
}

async function recordDistilledToolCall(
  ctx: PluginContext,
  input: any,
  output: any,
  sid: string | null,
  toolOutput: string,
): Promise<void> {
  if (!ctx.config.distiller.enabled || !sid) return;

  const filePath = (input.args?.filePath as string) ?? (input.args?.path as string) ?? undefined;
  const record: ToolCallRecord = {
    tool: input.tool,
    args: input.args ?? {},
    output: toolOutput,
    error: output.metadata?.error as string | undefined,
    exitCode: output.metadata?.exitCode as number | undefined,
    timestamp: Date.now(),
    sessionId: sid,
    filePath,
  };

  ctx.toolDistiller.record(record);
  if (ctx.toolDistiller.bufferLength >= 10) await autoDistill(ctx, sid);
}

async function recordContinuitySignals(
  ctx: PluginContext,
  input: any,
  output: any,
  sid: string | null,
  toolOutput: string,
): Promise<void> {
  if (!sid || !ctx.database) return;
  await cacheToolErrorSignal(ctx.database.getPool(), {
    sessionId: sid,
    toolName: input.tool as string,
    args: input.args ?? {},
    output: toolOutput,
    error: output.metadata?.error as string | undefined,
    exitCode: output.metadata?.exitCode as number | undefined,
  });
}

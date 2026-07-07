import { createHash } from 'node:crypto';
import type { PluginContext } from '../plugin-context.js';
import { cacheToolErrorSignal } from '../context-cache-signals.js';
import type { ToolCallRecord } from '../types.js';
import { ensureProjectDocsInitialized } from './auto-docs.js';
import { autoDistill, logToolUsage } from './tool-execute-memory.js';

/** Before-hook input shape (matches OpenCode plugin API). */
interface ToolExecuteBeforeInput {
  tool: string;
  sessionID: string;
  callID: string;
}

/** Before-hook output shape — args is the tool's input parameters. */
interface ToolExecuteBeforeOutput {
  args: Record<string, unknown>;
}

/** After-hook input shape — includes the resolved args. */
interface ToolExecuteAfterInput {
  tool: string;
  sessionID: string;
  callID: string;
  args: Record<string, unknown>;
}

/** After-hook output shape — tool execution result. */
interface ToolExecuteAfterOutput {
  title: string;
  output: string;
  metadata: ToolExecuteMetadata;
}

/** Tool execution metadata from the host. */
interface ToolExecuteMetadata {
  tokenCount?: number;
  error?: string;
  exitCode?: number;
}

export function createToolExecuteBeforeHook(ctx: PluginContext) {
  return async (input: ToolExecuteBeforeInput, output: ToolExecuteBeforeOutput) => {
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
  return async (input: ToolExecuteAfterInput, output: ToolExecuteAfterOutput) => {
    try {
      ctx.syncActiveSession(input.sessionID);
      const sid = ctx.state.currentSessionId;
      await ensureDocsInitialized(ctx);

      const toolOutput = summarizeToolOutput(output.output);
      const tokenSnapshot = output.metadata?.tokenCount ?? 0;
      recordWorkJournal(ctx, input, output, sid, toolOutput, tokenSnapshot);
      recordExperiencePacket(ctx, input, output, sid);
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

async function injectLessonWarning(ctx: PluginContext, input: ToolExecuteBeforeInput, output: ToolExecuteBeforeOutput): Promise<void> {
  try {
    await ctx.lessonTriggers.refresh();
    const warning = ctx.lessonTriggers.buildInjection(input.tool, output.args ?? {});
    if (warning) console.warn(`[LessonTriggers] Matched lesson for tool "${input.tool}":\n${warning}`);
  } catch { /* lesson refresh failed, skip */ }
}

async function maybeCreateRiskyEditCheckpoint(
  ctx: PluginContext,
  input: ToolExecuteBeforeInput,
  output: ToolExecuteBeforeOutput,
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
  input: ToolExecuteAfterInput,
  output: ToolExecuteAfterOutput,
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
  input: ToolExecuteAfterInput,
  output: ToolExecuteAfterOutput,
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

function recordExperiencePacket(
  ctx: PluginContext,
  input: ToolExecuteAfterInput,
  output: ToolExecuteAfterOutput,
  sid: string | null,
): void {
  if (!sid) return;

  // --- hashing helpers ---
  const hash = (val: unknown): string =>
    createHash('sha256').update(JSON.stringify(val ?? '')).digest('hex').slice(0, 16);

  const argsHash = hash(input.args);
  const outputHash = hash(output.output);
  const errorHash = hash(output.metadata?.error);
  const filePath = (input.args?.filePath as string) ?? (input.args?.path as string) ?? null;
  const isError = !!(output.metadata?.error || output.metadata?.exitCode);

  // --- milestone detection ---
  const editTools = new Set(['edit', 'write', 'multiedit']);
  const isEditTool = editTools.has(input.tool);
  const isMilestone = isEditTool && !isError && !!filePath;

  // --- free-text decision classifier ---
  const isFreeTextDecision =
    input.tool === 'question' &&
    typeof output.output === 'string' &&
    output.output.length > 0;

  // --- record to loop signal detector ---
  try {
    ctx.loopSignalDetector.record({
      toolName: input.tool,
      inputHash: argsHash,
      outputHash,
      errorHash,
      filePath,
      isError,
      isMilestone,
    });
  } catch {
    /* non-critical */
  }

  // --- check loop signal ---
  let loopSignal: ReturnType<typeof ctx.loopSignalDetector.check> = null;
  try {
    loopSignal = ctx.loopSignalDetector.check();
  } catch {
    /* non-critical */
  }

  // --- emit the tool_execution packet (always) ---
  const signals: Record<string, unknown> = {
    _schemaVersion: 2,
    _sourceHook: 'tool-execute',
    _correlationId: loopSignal?.correlationId,
    _evidenceRefs: loopSignal?.evidenceRefs,
    milestone: isMilestone,
    freeTextDecision: isFreeTextDecision,
    loopSignal: loopSignal ? {
      toolName: loopSignal.toolName,
      callCount: loopSignal.callCount,
      gateD1: loopSignal.gateD1,
      gateD2: loopSignal.gateD2,
      gateD2Reason: loopSignal.gateD2Reason,
    } : undefined,
  };

  ctx.experiencePackets.recordToolPacket({
    sessionId: sid,
    projectId: ctx.directory,
    toolName: input.tool,
    exitCode: output.metadata?.exitCode,
    error: output.metadata?.error,
    args: input.args ?? {},
    signals,
  }).catch((_err: unknown) => {
    /* experience packet recording non-critical */
  });

  // --- fire dedicated milestone packet ---
  if (isMilestone) {
    const intent = `file modified: ${filePath}`;
    ctx.experiencePackets.recordMilestonePacket({
      sessionId: sid,
      projectId: ctx.directory,
      intent,
      signalsMetadata: { toolName: input.tool, filePath },
    }).catch((_err: unknown) => {
      /* non-critical */
    });
  }

  // --- fire dedicated loop_signal packet ---
  if (loopSignal) {
    ctx.experiencePackets.recordLoopSignalPacket({
      sessionId: sid,
      projectId: ctx.directory,
      toolName: loopSignal.toolName,
      callCount: loopSignal.callCount,
      evidence: {
        gateD1: loopSignal.gateD1,
        gateD2: loopSignal.gateD2,
        gateD2Reason: loopSignal.gateD2Reason,
        evidenceRefs: loopSignal.evidenceRefs,
      },
    }).catch((_err: unknown) => {
      /* non-critical */
    });
  }

  // --- debounce-trigger maintenance pipeline ---
  ctx.lifecycleOrchestrator?.triggerDebounced('self-model', 5000);
  ctx.lifecycleOrchestrator?.triggerDebounced('belief-consolidation', 8000);

  // --- file-touch context primer ---
  const FILE_TOOLS = new Set(['read', 'edit', 'write', 'multiedit']);
  if (FILE_TOOLS.has(input.tool)) {
    const touchPath = (input.args?.filePath ?? input.args?.path) as string | undefined;
    if (touchPath) {
      ctx.state.pendingFileContext = null;
      ctx.fileContextPrimer?.tickCall();
      ctx.fileContextPrimer?.buildBlock(touchPath, ctx.directory)
        .then(block => {
          if (block) ctx.state.pendingFileContext = block;
        })
        .catch((_err: unknown) => { /* non-critical */ });
    }
  }

  // --- lint output parsing ---
  if (input.tool === 'bash' && ctx.lintDeltaTracker) {
    const cmd = (input.args?.command as string) ?? '';
    const outputStr = typeof output.output === 'string' ? output.output : '';
    if (/lint|eslint/i.test(cmd)) {
      const match = outputStr.match(/(\d+)\s+problems?\s*\((\d+)\s+errors?,\s*(\d+)\s+warnings?\)/i);
      if (match) {
        ctx.lintDeltaTracker.recordSnapshot({
          errors: +match[2],
          warnings: +match[3],
          maxWarnings: 0,
          changedFiles: [],
          toolName: cmd.includes(':src') ? 'lint:src' : 'lint',
        }).catch(() => { /* non-critical */ });
      }
    }
  }
}

async function recordContinuitySignals(
  ctx: PluginContext,
  input: ToolExecuteAfterInput,
  output: ToolExecuteAfterOutput,
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

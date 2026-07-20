import type { PluginContext } from '../plugin-context.js';
import { flushDocUpdates, getPendingUpdates } from './auto-docs.js';
import { packageCommandEvidence, packageToolEvidence } from './tool-execute-budget.js';
import { ToolExecuteRuntimeDedup } from '../tool-execute-runtime-dedup.js';
import { getLogger } from '../logger.js';
import { projectKey } from './doc-project-key.js';
import { Redactor, redactJsonValue } from '../redactor.js';

// Per-workfolder flush timers — keyed by projectKey(ctx.directory)
const flushTimersByKey = new Map<string, ReturnType<typeof setTimeout>>();
const FLUSH_DELAY_MS = 2000;
const toolDedup = new ToolExecuteRuntimeDedup(60_000);

export function scheduleDocFlushLocal(ctx: PluginContext): void {
  const key = projectKey(ctx.directory);
  // Rescheduling the same project cancels its previous timer
  const existing = flushTimersByKey.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    // Delete ourselves only if we are still the active timer for this key
    const current = flushTimersByKey.get(key);
    if (current === timer) {
      flushTimersByKey.delete(key);
    }
    if (getPendingUpdates(ctx.directory).length === 0) return;
    try {
      await flushDocUpdates(ctx, ctx.directory);
    } catch (err) {
      getLogger().error('Auto-doc background flush failed', toError(err), {
        projectId: ctx.directory,
      });
    }
  }, FLUSH_DELAY_MS);
  flushTimersByKey.set(key, timer);
}

/**
 * Manually flush a specific project's pending docs and clear its timer.
 * Only clears the timer for that project — other projects' timers are untouched.
 */
export function manualFlushProject(ctx: PluginContext): Promise<void> {
  const key = projectKey(ctx.directory);
  const existing = flushTimersByKey.get(key);
  if (existing) {
    clearTimeout(existing);
    flushTimersByKey.delete(key);
  }
  return flushDocUpdates(ctx, ctx.directory);
}

/**
 * Clear all timers (for testing / full teardown).
 */
export function clearAllFlushTimers(): void {
  for (const timer of flushTimersByKey.values()) {
    clearTimeout(timer);
  }
  flushTimersByKey.clear();
}

export async function autoDistill(ctx: PluginContext, sid: string): Promise<void> {
  const summary = ctx.toolDistiller.distill();
  if (summary.groups.length === 0) return;

  const pool = ctx.database.getPool();
  const redactor = ctx.redactor ?? new Redactor();
  const safeSummary = {
    ...summary,
    groups: redactJsonValue(redactor, summary.groups),
    compressed: redactor.redact(summary.compressed).text,
  };
  await pool.query(
    `INSERT INTO distilled_summaries (id, session_id, groups, compressed, total_calls_summarized)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (session_id, md5(compressed)) DO NOTHING`,
    [safeSummary.id, sid, JSON.stringify(safeSummary.groups), safeSummary.compressed, safeSummary.totalCallsSummarized],
  );

  if (ctx.config.distiller.autoSaveAsMemory) {
    await ctx.memoryExtractor.extractFromDistilledSummaries(sid, sid, safeSummary);
  }

  ctx.experiencePackets.recordDistillGroupPacket({
    sessionId: sid,
    projectId: ctx.directory,
    groupCount: safeSummary.groups.length,
    totalCallsSummarized: safeSummary.totalCallsSummarized,
    compressedPreview: safeSummary.compressed,
  }).catch((error: unknown) => {
    getLogger().error('Experience packet background write failed', toError(error), {
      projectId: ctx.directory,
      sessionId: sid,
    });
  });

  await ctx.refreshActiveContext(sid);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function shouldLogTool(tool: string): boolean {
  return [
    'read', 'write', 'edit', 'glob', 'grep', 'bash', 'task',
    'memory_save', 'memory_search', 'memory_lesson',
    'csm_memory_save', 'csm_memory_search', 'csm_memory_lesson',
  ].includes(tool);
}

export async function logToolUsage(
  ctx: PluginContext,
  input: unknown,
  output: unknown,
  sid: string | null,
): Promise<void> {
  const inputRecord = input as Record<string, unknown>;
  const outputRecord = output as Record<string, unknown>;
  const packagedToolMetadata = await packageToolEvidence(ctx, inputRecord, outputRecord);

  if (shouldLogTool(inputRecord.tool as string)) {
    if (toolDedup.shouldSuppress(inputRecord.tool as string, inputRecord.args)) {
      return;
    }
    await ctx.memoryManager.saveMemory({
      content: `Tool used: ${inputRecord.tool as string}`,
      type: 'episodic',
      importance: 0.2,
      source: 'auto',
      tags: ['tool-usage', inputRecord.tool as string],
      metadata: {
        tool: inputRecord.tool as string,
        args: inputRecord.args,
        outputPreview: typeof outputRecord.output === 'string'
          ? (outputRecord.output as string).substring(0, 200)
          : 'non-string output',
        contextBudget: packagedToolMetadata?.contextBudget,
        evidenceRef: packagedToolMetadata?.evidenceRef,
        tokensAvoided: packagedToolMetadata?.tokensAvoided,
      },
      sessionId: sid ?? undefined,
      projectId: ctx.directory,
    });
  }

  const tool = inputRecord.tool as string;
  const args = inputRecord.args as Record<string, unknown> | undefined;

  if (tool === 'write' || tool === 'edit' || tool === 'multiedit') {
    const filePath = args?.filePath ?? args?.path ?? 'unknown';
    await ctx.memoryManager.saveMemory({
      content: `File ${tool === 'write' ? 'written' : 'edited'}: ${filePath}`,
      type: 'episodic',
      importance: 0.4,
      source: 'auto',
      tags: ['file-operation', tool],
      metadata: { operation: tool, filePath },
      sessionId: sid ?? undefined,
      projectId: ctx.directory,
    });
  }

  if (ctx.config.logCommands && tool === 'bash') {
    const metadata = await packageCommandEvidence(ctx, inputRecord, outputRecord);
     const command = String(args?.command ?? 'unknown');
     await ctx.memoryManager.saveMemory({
       content: `Command executed: ${command.substring(0, 200)}`,
       type: 'procedural',
       importance: 0.3,
       source: 'auto',
       tags: ['command', 'procedural', 'context-budget'],
       metadata: metadata ?? { command: command.substring(0, 500) },
       sessionId: sid ?? undefined,
       projectId: ctx.directory,
     });
   }
  }

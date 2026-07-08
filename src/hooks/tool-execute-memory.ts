import type { PluginContext } from '../plugin-context.js';
import { flushDocUpdates, getPendingUpdates } from './auto-docs.js';
import { packageCommandEvidence, packageToolEvidence } from './tool-execute-budget.js';
import { ToolExecuteRuntimeDedup } from '../tool-execute-runtime-dedup.js';

let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DELAY_MS = 2000;
const toolDedup = new ToolExecuteRuntimeDedup(60_000);

export function scheduleDocFlushLocal(ctx: PluginContext): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    if (getPendingUpdates().length === 0) return;
    try {
      await flushDocUpdates(ctx, ctx.directory);
    } catch (err) {
      console.error('[CrossSessionMemory] Auto-doc flush error:', err);
    }
  }, FLUSH_DELAY_MS);
}

export async function autoDistill(ctx: PluginContext, sid: string): Promise<void> {
  const summary = ctx.toolDistiller.distill();
  if (summary.groups.length === 0) return;

  const pool = ctx.database.getPool();
  await pool.query(
    `INSERT INTO distilled_summaries (id, session_id, groups, compressed, total_calls_summarized)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (session_id, md5(compressed)) DO NOTHING`,
    [summary.id, sid, JSON.stringify(summary.groups), summary.compressed, summary.totalCallsSummarized],
  );

  if (ctx.config.distiller.autoSaveAsMemory) {
    await ctx.memoryExtractor.extractFromDistilledSummaries(sid, sid, summary);
  }

  ctx.experiencePackets.recordDistillGroupPacket({
    sessionId: sid,
    projectId: ctx.directory,
    groupCount: summary.groups.length,
    totalCallsSummarized: summary.totalCallsSummarized,
    compressedPreview: summary.compressed,
  }).catch((_err: unknown) => {
    /* non-critical */
  });

  await ctx.refreshActiveContext(sid);
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
     });
   }
  }

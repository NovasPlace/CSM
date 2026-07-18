import type { PluginInput } from '@opencode-ai/plugin';
import type { PluginContext } from '../plugin-context.js';
import { SelfContinuityGenerator } from '../self-continuity-generator.js';

export async function persistFinalDistillation(pluginCtx: PluginContext): Promise<void> {
  const { config, database, toolDistiller, redactor, state } = pluginCtx;
  if (!config.distiller.enabled || !state.currentSessionId) return;
  const summary = toolDistiller.distill();
  if (summary.groups.length === 0) return;
  await database.getPool().query(
    `INSERT INTO distilled_summaries (id, session_id, groups, compressed, total_calls_summarized)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (session_id, md5(compressed)) DO NOTHING`,
    [summary.id, state.currentSessionId,
      redactor.redact(JSON.stringify(summary.groups)).text,
      redactor.redact(summary.compressed).text, summary.totalCallsSummarized],
  );
}

export async function persistSessionSnapshot(pluginCtx: PluginContext): Promise<void> {
  const { config, memoryManager, state } = pluginCtx;
  if (!state.currentSessionId || !config.logSessionLifecycle) return;
  await memoryManager.saveMemory({
    content: `Session ended after ${state.messageCount} messages. Final context snapshot.`,
    type: 'episodic', importance: 0.3, source: 'auto',
    tags: ['session-end', 'final-snapshot'],
    metadata: { sessionId: state.currentSessionId, messageCount: state.messageCount },
    sessionId: state.currentSessionId,
    projectId: pluginCtx.directory,
  });
}

export async function persistWorkJournal(
  ctx: PluginInput,
  pluginCtx: PluginContext,
): Promise<void> {
  const { config, workJournal, state } = pluginCtx;
  if (!state.currentSessionId || !config.workJournal?.persistOnDispose) return;
  await workJournal.recordSessionEnd(state.currentSessionId, ctx.directory, state.messageCount);
}

export async function persistExperiencePacket(pluginCtx: PluginContext): Promise<void> {
  const { experiencePackets, state, directory } = pluginCtx;
  if (!state.currentSessionId) return;
  await experiencePackets.recordToolPacket({
    sessionId: state.currentSessionId, projectId: directory,
    toolName: 'session_end', exitCode: 0,
    args: { messageCount: state.messageCount },
    signals: { _schemaVersion: 2, _sourceHook: 'dispose-hooks', messageCount: state.messageCount },
  });
}

export async function persistSelfContinuity(pluginCtx: PluginContext): Promise<void> {
  const { config, database, state, directory } = pluginCtx;
  if (!state.currentSessionId || !config.selfContinuity.enabled) return;
  const generator = new SelfContinuityGenerator(database.getPool(), state.currentSessionId, directory);
  await generator.writeRecord('session_end', {
    recalledSessionIds: [], recalledMemoryIds: [], evidenceAnchors: [],
    selfObservation: `Session ended after ${state.messageCount} messages.`,
    feltGap: undefined, goalContinued: false, alchemistInjected: false,
    checkpointResumed: false,
  });
}

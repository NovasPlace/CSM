import type { PluginInput } from '@opencode-ai/plugin';
import type { PluginContext } from '../plugin-context.js';
import { SelfContinuityGenerator } from '../self-continuity-generator.js';
import { flushDocUpdates } from './auto-docs.js';

export async function disposeAll(
  ctx: PluginInput,
  pluginCtx: PluginContext,
): Promise<void> {
  const { config, database, memoryManager, toolDistiller, redactor,
    contextRecall, subconscious, gitWatcher, workJournal, statsWriter,
    state, directory } = pluginCtx;
  const logging = await import('../logger.js').then(m => m.getLogger());

  logging.info('Disposing...');

  if (config.distiller.enabled && state.currentSessionId) {
    const summary = toolDistiller.distill();
    if (summary.groups.length > 0) {
      try {
        const pool = database.getPool();
        const redactedCompressed = redactor.redact(summary.compressed).text;
        const redactedGroups = redactor.redact(JSON.stringify(summary.groups)).text;
        await pool.query(
          `INSERT INTO distilled_summaries (id, session_id, groups, compressed, total_calls_summarized)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (session_id, md5(compressed)) DO NOTHING`,
          [
            summary.id,
            state.currentSessionId,
            redactedGroups,
            redactedCompressed,
            summary.totalCallsSummarized,
          ],
        );
      } catch (error) {
        logging.error('Final distillation failed', error as Error);
      }
    }
  }

  if (state.currentSessionId && config.logSessionLifecycle) {
    await memoryManager.saveMemory({
      content: `Session ended after ${state.messageCount} messages. Final context snapshot.`,
      type: 'episodic',
      importance: 0.3,
      source: 'auto',
      tags: ['session-end', 'final-snapshot'],
      metadata: { sessionId: state.currentSessionId, messageCount: state.messageCount },
      sessionId: state.currentSessionId,
    });
  }
  if (state.currentSessionId && config.workJournal?.persistOnDispose) {
    workJournal.recordSessionEnd(state.currentSessionId, ctx.directory, state.messageCount);
  }

  if (state.currentSessionId) {
    try {
      await pluginCtx.experiencePackets.recordToolPacket({
        sessionId: state.currentSessionId,
        projectId: directory,
        toolName: 'session_end',
        exitCode: 0,
        args: { messageCount: state.messageCount },
        signals: {
          _schemaVersion: 2,
          _sourceHook: 'dispose-hooks',
          messageCount: state.messageCount,
        },
      });
    } catch {
      /* experience packet recording non-critical */
    }
  }

  if (state.currentSessionId && config.selfContinuity.enabled) {
    try {
      const generator = new SelfContinuityGenerator(
        database.getPool(),
        state.currentSessionId,
        directory,
      );
      await generator.writeRecord('session_end', {
        recalledSessionIds: [],
        recalledMemoryIds: [],
        evidenceAnchors: [],
        selfObservation: `Session ended after ${state.messageCount} messages.`,
        feltGap: undefined,
        goalContinued: false,
        alchemistInjected: false,
        checkpointResumed: false,
      });
    } catch (error) {
      logging.error('Self-continuity record failed', error as Error);
    }
  }

  contextRecall.stop();
  subconscious.stop();
  gitWatcher.stop();

  await memoryManager.cleanup();
  await database.disconnect();
  await flushDocUpdates(pluginCtx, ctx.directory);

  await statsWriter.write().catch(() => {});
  statsWriter.stop();

  logging.info('Disposed');
}

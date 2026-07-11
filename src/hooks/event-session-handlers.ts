import type { PluginInput } from '@opencode-ai/plugin';
import { randomUUID } from 'node:crypto';
import { getLogger } from '../logger.js';
import type { PluginContext } from '../plugin-context.js';

export async function handleSessionCreated(
  ctx: PluginInput,
  pluginCtx: PluginContext,
  event: Record<string, unknown>,
): Promise<void> {
  if (event.type !== 'session.created') return;
  const info = properties(event).info as Record<string, unknown> | undefined;
  const session = await pluginCtx.memoryManager.createSession(String(info?.id ?? ''), ctx.directory);
  pluginCtx.syncActiveSession(session.id);
  pluginCtx.subconscious.watchPath(ctx.directory);
  const autoDocs = await import('./auto-docs.js');
  autoDocs.invalidateProject(ctx.directory);
  autoDocs.resetSessionFlushState(ctx.directory);
  if (ctx.worktree) pluginCtx.gitWatcher.watchRepo(ctx.worktree);
  if (pluginCtx.config.logSessionLifecycle) {
    await pluginCtx.memoryManager.saveMemory({
      content: `Session started in ${ctx.directory}`, type: 'episodic', importance: 0.3,
      source: 'auto', tags: ['session-start'],
      metadata: { sessionId: session.id, directory: ctx.directory }, sessionId: session.id,
    });
  }
  await recordStartPacket(pluginCtx, session.id, ctx.directory);
}

export async function handleSessionUpdated(
  ctx: PluginInput,
  pluginCtx: PluginContext,
  event: Record<string, unknown>,
): Promise<void> {
  const { state, experiencePackets } = pluginCtx;
  if (event.type !== 'session.updated' || !state.currentSessionId) return;
  try {
    await experiencePackets.recordSessionCheckpointPacket({
      sessionId: state.currentSessionId, projectId: ctx.directory,
      messageCount: state.messageCount,
      signalsMetadata: metadata('session_id', state.currentSessionId),
    });
  } catch {
    getLogger().warn('session_checkpoint packet write failed', {});
  }
}

export async function handleFileEdited(
  pluginCtx: PluginContext,
  event: Record<string, unknown>,
): Promise<void> {
  if (event.type !== 'file.edited') return;
  await pluginCtx.subconscious.captureFileChange({
    filePath: String(properties(event).file ?? ''),
    eventType: 'modified',
    timestamp: new Date(),
  });
}

function properties(event: Record<string, unknown>): Record<string, unknown> {
  return event.properties as Record<string, unknown>;
}

async function recordStartPacket(
  pluginCtx: PluginContext,
  sessionId: string,
  projectId: string,
): Promise<void> {
  try {
    await pluginCtx.experiencePackets.recordSessionStartPacket({
      sessionId, projectId, signalsMetadata: metadata('session_id', sessionId),
    });
  } catch {
    getLogger().warn('session_start packet write failed', {});
  }
}

function metadata(kind: string, id: string) {
  return { _schemaVersion: 1, _sourceHook: 'event-hook', _correlationId: randomUUID(),
    _evidenceRefs: [{ kind, id }] };
}

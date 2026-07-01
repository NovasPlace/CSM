import type { PluginInput } from '@opencode-ai/plugin';
import type { PluginContext } from '../plugin-context.js';
import { getLogger } from '../logger.js';

export function createEventHook(
  ctx: PluginInput,
  pluginCtx: PluginContext,
): (args: { event: any }) => Promise<void> {
  const { config, memoryManager, syncActiveSession, subconscious, gitWatcher, workJournal, state } = pluginCtx;

  return async ({ event }) => {
    try {
      if (event.type === 'session.created') {
        const session = await memoryManager.createSession(
          event.properties.info.id,
          ctx.directory,
        );
        syncActiveSession(session.id);
        subconscious.watchPath(ctx.directory);

        if (ctx.worktree) {
          gitWatcher.watchRepo(ctx.worktree);
        }

        if (config.logSessionLifecycle) {
          await memoryManager.saveMemory({
            content: `Session started in ${ctx.directory}`,
            type: 'episodic',
            importance: 0.3,
            source: 'auto',
            tags: ['session-start'],
            metadata: { sessionId: session.id, directory: ctx.directory },
            sessionId: session.id,
          });
        }
      }

      if (event.type === 'session.updated' && state.currentSessionId) {
        if (config.logSessionLifecycle) {
          await memoryManager.saveMemory({
            content: `Session ended after ${state.messageCount} messages`,
            type: 'episodic',
            importance: 0.3,
            source: 'auto',
            tags: ['session-end'],
            metadata: { sessionId: state.currentSessionId, messageCount: state.messageCount },
            sessionId: state.currentSessionId,
          });
        }
        workJournal.recordSessionEnd(state.currentSessionId, ctx.directory, state.messageCount);
      }

      if (event.type === 'file.edited') {
        await subconscious.captureFileChange({
          filePath: event.properties.file,
          eventType: 'modified',
          timestamp: new Date(),
        });
      }

      if (event.type === 'message.updated') {
        const info = event.properties.info;
        getLogger().debug(`message.updated fired - role: ${info?.role}, id: ${info?.id}`, { turnId: info?.id });

        if (info && info.role === 'assistant' && config.fullTranscripts) {
          const messageId = info.id;
          try {
            getLogger().debug(`Fetching messages for session ${info.sessionID}`);
            const result = await ctx.client.session.messages({ path: { id: info.sessionID } });
            const messages = result.data;
            getLogger().debug(`Got ${messages?.length ?? 0} messages from SDK`);

            if (messages) {
              const msg = messages.find((m: { info: { id: string } }) => m.info.id === messageId);
              getLogger().debug(`Found target message: ${!!msg}, parts: ${msg?.parts?.length ?? 0}`);

              if (msg && msg.parts) {
                let fullContent = '';
                for (const part of msg.parts) {
                  if (part.type === 'text' && 'text' in part) {
                    fullContent += (part as { text: string }).text + '\n';
                  }
                }

                getLogger().debug(`Extracted content: ${fullContent.length} chars`);

                const existingLen = state.capturedMessageSizes.get(messageId) || 0;
                const shouldCapture = fullContent.trim().length > 0 && fullContent.length > existingLen;

                if (shouldCapture) {
                  state.capturedMessageSizes.set(messageId, fullContent.length);

                  if (state.capturedMessageSizes.size > 500) {
                    const entries = [...state.capturedMessageSizes.entries()];
                    state.capturedMessageSizes.clear();
                    entries.slice(-250).forEach(([id, len]) => state.capturedMessageSizes.set(id, len));
                  }

                  let importance = 0.3;
                  const lower = fullContent.toLowerCase();
                  if (lower.includes('decision') || lower.includes('solution')) importance = 0.6;
                  if (lower.includes('error') || lower.includes('fix') || lower.includes('bug')) importance = 0.5;

                  state.messageCount++;

                  getLogger().debug(`Capturing ASSISTANT message ${messageId} (${fullContent.length} chars, prev: ${existingLen})`);

                  await memoryManager.saveMemory({
                    content: `[assistant] ${fullContent.trim()}`,
                    type: 'conversation',
                    importance,
                    source: 'auto',
                    tags: ['auto-captured', 'conversation', 'full-transcript', 'assistant'],
                    metadata: {
                      messageId,
                      role: 'assistant',
                      fullTranscript: true,
                      partCount: msg?.parts?.length ?? 0,
                    },
                    sessionId: info.sessionID,
                  });
                  workJournal.recordDecision({
                    sessionId: info.sessionID,
                    projectId: ctx.directory,
                    intent: fullContent.trim().substring(0, 200),
                    filesTouched: [],
                  });

                  if (config.promptDebug) {
                    getLogger().debug('Debug: writing prompt debug log - context not available here');
                  }
                }
              }
            }
          } catch (error) {
            getLogger().error('Messages transform error', error as Error);
          }
        }
      }
    } catch (error) {
      getLogger().error('Event handler failed', error as Error);
    }
  };
}

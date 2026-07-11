import { randomUUID } from 'node:crypto';
import type { ContextRecallDaemon } from './context-recall.js';
import type { GitWatcher } from './git-watcher.js';
import type { PluginContext, PluginState } from './plugin-context.js';
import type { SubconsciousWatcher } from './subconscious.js';

type StateServices = Pick<PluginContext, 'state' | 'syncActiveSession' | 'refreshActiveContext'>;

export function createPluginStateServices(
  contextRecall: ContextRecallDaemon,
  subconscious: SubconsciousWatcher,
  gitWatcher: GitWatcher,
  projectId: string,
): StateServices {
  const state = createPluginState();
  const syncActiveSession = (sessionId?: string): string | null => {
    if (!sessionId) return state.currentSessionId;
    state.currentSessionId = sessionId;
    contextRecall.setSession(sessionId, projectId);
    subconscious.setSession(sessionId);
    gitWatcher.setSession(sessionId);
    return sessionId;
  };
  const refreshActiveContext = async (sessionId?: string): Promise<void> => {
    const activeSessionId = syncActiveSession(sessionId);
    if (activeSessionId) await contextRecall.refreshSession(activeSessionId, projectId);
  };
  return { state, syncActiveSession, refreshActiveContext };
}

function createPluginState(): PluginState {
  return {
    currentSessionId: null,
    runId: process.env.CSM_RUN_ID?.trim() || randomUUID(),
    currentModelId: process.env.CSM_MODEL_ID?.trim() || 'unknown',
    modelIdPinned: !!process.env.CSM_MODEL_ID?.trim(),
    modelIdBySession: new Map(), messageCount: 0,
    capturedMessageSizes: new Map(), recentUserMessages: new Map(),
    sourceOnlySessions: new Set(), sourceOnlyUntilMs: undefined,
    reentryInjected: new Set(), onboardingInjected: new Set(),
  };
}

import type { PluginInput } from '@opencode-ai/plugin';
import type { PluginContext } from '../plugin-context.js';
import { flushDocUpdates } from './auto-docs.js';
import { clearAllFlushTimers } from './tool-execute-memory.js';
import {
  persistExperiencePacket,
  persistFinalDistillation,
  persistSelfContinuity,
  persistSessionSnapshot,
  persistWorkJournal,
} from './dispose-persistence.js';

interface DisposalState {
  completed: Set<string>;
  promise: Promise<void> | null;
  done: boolean;
}

const DISPOSALS = new WeakMap<object, DisposalState>();

export function disposeAll(ctx: PluginInput, pluginCtx: PluginContext): Promise<void> {
  const state = DISPOSALS.get(pluginCtx) ?? { completed: new Set(), promise: null, done: false };
  DISPOSALS.set(pluginCtx, state);
  if (state.done) return Promise.resolve();
  if (state.promise) return state.promise;
  state.promise = runDisposal(ctx, pluginCtx, state).then(
    () => { state.promise = null; state.done = true; },
    (error) => { state.promise = null; throw error; },
  );
  return state.promise;
}

async function runDisposal(
  ctx: PluginInput,
  pluginCtx: PluginContext,
  state: DisposalState,
): Promise<void> {
  const logging = await import('../logger.js').then((module) => module.getLogger());
  const errors: Error[] = [];
  logging.info('Disposing...');
  // Cancel all pending auto-docs timers FIRST, before any async work.
  // A timer callback that fires mid-disposal would access a stale PluginContext.
  clearAllFlushTimers();
  await capture(state, errors, 'final distillation', () => persistFinalDistillation(pluginCtx));
  await capture(state, errors, 'session snapshot', () => persistSessionSnapshot(pluginCtx));
  await capture(state, errors, 'work journal', () => persistWorkJournal(ctx, pluginCtx));
  await capture(state, errors, 'experience packet', () => persistExperiencePacket(pluginCtx));
  await capture(state, errors, 'self continuity', () => persistSelfContinuity(pluginCtx));
  await stopRuntimeServices(pluginCtx, state, errors);
  await capture(state, errors, 'memory cleanup', () => pluginCtx.memoryManager.cleanup());
  await capture(state, errors, 'stats flush', () => pluginCtx.statsWriter.stopAndFlush());
  await capture(state, errors, 'work ledger', async () => pluginCtx.workLedger?.dispose());
  await capture(state, errors, 'context injection telemetry', async () => pluginCtx.contextInjectionLogger?.flush());
  await capture(state, errors, 'documentation flush', () => flushDocUpdates(pluginCtx, ctx.directory));
  if (errors.length === 0) {
    await capture(state, errors, 'database disconnect', () => pluginCtx.database.disconnect());
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Runtime cleanup failed');
  logging.info('Disposed');
}

async function stopRuntimeServices(
  pluginCtx: PluginContext,
  state: DisposalState,
  errors: Error[],
): Promise<void> {
  await capture(state, errors, 'lifecycle stop', async () => pluginCtx.lifecycleOrchestrator?.stop());
  await capture(state, errors, 'context recall stop', async () => pluginCtx.contextRecall.stop());
  await capture(state, errors, 'subconscious stop', async () => pluginCtx.subconscious.stop());
  await capture(state, errors, 'git watcher stop', async () => pluginCtx.gitWatcher.stop());
}

async function capture(
  state: DisposalState,
  errors: Error[],
  label: string,
  task: () => Promise<unknown>,
): Promise<void> {
  if (state.completed.has(label)) return;
  try {
    await task();
    state.completed.add(label);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(new Error(`${label}: ${message}`, { cause: error }));
  }
}

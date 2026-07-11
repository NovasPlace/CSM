import type { PluginInput } from '@opencode-ai/plugin';
import { createAutoCheckpoint } from './helpers/auto-checkpoint.js';
import { Database } from './database.js';
import { DecisionRegistry } from './decision-registry.js';
import { FileContextPrimer } from './file-context-primer.js';
import { KnownDebtRegistry } from './known-debt-registry.js';
import { LifecycleOrchestrator } from './lifecycle-orchestrator.js';
import { LintDeltaTracker } from './lint-delta-tracker.js';
import type { Logger } from './logger.js';
import { MilestoneTracker } from './milestone-tracker.js';
import type { PluginContext } from './plugin-context.js';
import { createPluginStateServices } from './plugin-runtime-state.js';
import {
  createContinuityServices,
  createCoreServices,
  createPersistenceServices,
} from './plugin-runtime-services.js';
import { StartupRollback } from './startup-rollback.js';
import { StatsWriter } from './stats-writer.js';
import type { PluginConfig } from './types.js';

export interface PluginStartupBoundary<T = PluginContext> {
  afterDatabaseConnect?(database: Database): void | Promise<void>;
  beforeCommit?(pluginCtx: PluginContext): void | Promise<void>;
  activate?(pluginCtx: PluginContext): T | Promise<T>;
}

export async function startPluginContext<T = PluginContext>(
  ctx: PluginInput,
  config: PluginConfig,
  logging: Logger,
  boundary: PluginStartupBoundary<T> = {},
): Promise<T> {
  const rollback = new StartupRollback();
  const database = new Database(config);
  try {
    await startDatabase(database, rollback, boundary);
    logging.info('Database connected');
    const core = createCoreServices(database, config);
    const persisted = createPersistenceServices(ctx, database, config, core);
    rollback.defer('Work Ledger', async () => persisted.workLedger?.dispose());
    const continuity = createContinuityServices(database, config, core, persisted);
    const state = createPluginStateServices(
      core.contextRecall, core.subconscious, core.gitWatcher, ctx.directory,
    );
    const statsWriter = startStats(database, config, rollback);
    startRuntimeServices(core, rollback);
    const pluginCtx = assembleContext(
      ctx, config, database, core, persisted, continuity, state, statsWriter,
    );
    startLifecycle(pluginCtx, rollback);
    await boundary.beforeCommit?.(pluginCtx);
    const result = boundary.activate
      ? await boundary.activate(pluginCtx) : pluginCtx as unknown as T;
    logging.info('AUTOMATED memory system initialized');
    core.contextRecall.start();
    rollback.commit();
    return result;
  } catch (error) {
    return rollback.fail(error);
  }
}

async function startDatabase(
  database: Database,
  rollback: StartupRollback,
  boundary: Pick<PluginStartupBoundary<unknown>, 'afterDatabaseConnect'>,
): Promise<void> {
  await database.connect();
  rollback.defer('database close', () => database.close());
  await boundary.afterDatabaseConnect?.(database);
}

function startRuntimeServices(
  core: ReturnType<typeof createCoreServices>,
  rollback: StartupRollback,
): void {
  rollback.defer('context recall', async () => core.contextRecall.stop());
  rollback.defer('subconscious watcher', async () => core.subconscious.stop());
  core.subconscious.start();
  rollback.defer('git watcher', async () => core.gitWatcher.stop());
  core.gitWatcher.start();
}

function startStats(
  database: Database,
  config: PluginConfig,
  rollback: StartupRollback,
): StatsWriter {
  const stats = new StatsWriter(database.getPool(), undefined, config.databaseProvider === 'postgres');
  rollback.defer('stats writer', () => stats.stopAndFlush());
  stats.start();
  return stats;
}

function assembleContext(
  ctx: PluginInput,
  config: PluginConfig,
  database: Database,
  core: ReturnType<typeof createCoreServices>,
  persisted: ReturnType<typeof createPersistenceServices>,
  continuity: ReturnType<typeof createContinuityServices>,
  state: ReturnType<typeof createPluginStateServices>,
  statsWriter: StatsWriter,
): PluginContext {
  const { beliefScanner: _beliefScanner, ...persistentContext } = persisted;
  return {
    config, database, ...core, ...persistentContext, ...continuity, ...state, statsWriter,
    client: ctx.client, directory: ctx.directory, worktree: ctx.worktree,
    autoCheckpoint: (sessionId, trigger, details) => createAutoCheckpoint(
      { checkpointStore: persisted.checkpointStore, config: config.checkpoint },
      sessionId, trigger, details,
    ),
    lastCompileResult: null,
  };
}

function startLifecycle(pluginCtx: PluginContext, rollback: StartupRollback): void {
  attachRegistries(pluginCtx);
  const lifecycle = new LifecycleOrchestrator(pluginCtx);
  pluginCtx.lifecycleOrchestrator = lifecycle;
  rollback.defer('lifecycle orchestrator', async () => lifecycle.stop());
  lifecycle.start();
}

function attachRegistries(pluginCtx: PluginContext): void {
  const memory = pluginCtx.memoryManager;
  pluginCtx.decisionRegistry = new DecisionRegistry(memory);
  pluginCtx.knownDebtRegistry = new KnownDebtRegistry(memory);
  pluginCtx.lintDeltaTracker = new LintDeltaTracker(memory);
  pluginCtx.milestoneTracker = new MilestoneTracker(memory);
  pluginCtx.fileContextPrimer = new FileContextPrimer(
    pluginCtx.decisionRegistry, memory, pluginCtx.knownDebtRegistry,
  );
}

/**
 * Cross-Session Memory Plugin - Hook and Tool Registration
 * Thin orchestrator: initializes services and wires sub-modules together.
 */
import { PluginInput, PluginOptions, Hooks } from '@opencode-ai/plugin';
import { Database } from './database.js';
import { EmbeddingGenerator } from './embeddings.js';
import { Redactor } from './redactor.js';
import { validateAndReturnConfig } from './config.js';
import { Logger } from './logger.js';
import { MemoryManager } from './memory-manager.js';
import { MemoryExtractor } from './memory-extractor.js';
import { PrimingEngine } from './priming-engine.js';
import { ContextRecallDaemon } from './context-recall.js';
import { getLogger } from './logger.js';
import { SubconsciousWatcher } from './subconscious.js';
import { GitWatcher } from './git-watcher.js';
import { LoopDetector } from './loop-detector.js';
import { ContextPressure } from './context-pressure.js';
import { ToolCallDistiller } from './tool-distiller.js';
import { ContextCompactor } from './context-compactor.js';
import { AdaptiveContextGovernor } from './context-governor.js';
import { TokenBudgetLedger } from './token-budget-ledger.js';
import { CheckpointStore } from './checkpoint-store.js';
import { AgentWorkJournal } from './agent-work-journal.js';
import { LessonTriggerCache } from './lesson-trigger-cache.js';
import { StatsWriter } from './stats-writer.js';
import type { PluginContext } from './plugin-context.js';
import type { CheckpointToolDeps } from './checkpoint-tool.js';
import type { CheckpointInjectDeps } from './checkpoint-inject.js';
import type { AutoCheckpointTrigger } from './helpers/auto-checkpoint.js';
import { createAutoCheckpoint } from './helpers/auto-checkpoint.js';
import { createSystemTransformHook } from './hooks/system-transform.js';
import { createSessionCompactingHook, createAutocontinueHook } from './hooks/session-compaction.js';
import { createToolExecuteBeforeHook, createToolExecuteAfterHook } from './hooks/tool-execute.js';
import { createEventHook } from './hooks/event-hooks.js';
import { registerTools } from './hooks/tool-hooks.js';
import { disposeAll } from './hooks/dispose-hooks.js';

export async function registerHooks(
  ctx: PluginInput,
  options?: PluginOptions,
  defaultExports: any = {}
): Promise<Hooks> {
  const config = validateAndReturnConfig();
  const mergedConfig = { ...config, ...(options as any ?? {}) };

  const logging = new Logger({
    sessionId: undefined,
    projectId: ctx.directory ?? null,
    verbose: mergedConfig.promptDebug,
  });

  logging.info('Initializing AUTOMATED memory system...');

  const database = new Database(config);

  try {
    await database.connect();
    logging.info('Database connected');
  } catch (error) {
    logging.error('Database connection failed', error as Error);
  }

  const embeddings = new EmbeddingGenerator(config);
  const redactor = new Redactor(config.redactor);
  const memoryManager = new MemoryManager(database, embeddings, redactor);
  const memoryExtractor = new MemoryExtractor(database, memoryManager, config.extractor);
  const primingEngine = new PrimingEngine(database);
  const contextRecall = new ContextRecallDaemon(database, config.contextRecallInterval);
  const tokenLedger = new TokenBudgetLedger(database.getPool());
  const subconscious = new SubconsciousWatcher(memoryManager, config.subconsciousWatchInterval, config.filterBuildArtifacts);
  const gitWatcher = new GitWatcher(memoryManager, config.gitPollInterval);
  const loopDetector = new LoopDetector(config.loopDetectionThreshold);
  const contextPressure = new ContextPressure(config.contextPressureRecommend, config.contextPressureDemand);
  const toolDistiller = new ToolCallDistiller(config.distiller);
  const contextCompactor = new ContextCompactor(config.compactor);
  const contextGovernor = new AdaptiveContextGovernor(config.contextCompiler, config.contextGovernor);

  const projectId = ctx.directory;

  const sessionState = {
    currentSessionId: null as string | null,
    messageCount: 0,
    capturedMessageSizes: new Map<string, number>(),
    recentUserMessages: new Map<string, string>(),
  };

  const syncActiveSession = (sessionId?: string): string | null => {
    if (!sessionId) return sessionState.currentSessionId;
    sessionState.currentSessionId = sessionId;
    contextRecall.setSession(sessionId, projectId);
    subconscious.setSession(sessionId);
    gitWatcher.setSession(sessionId);
    return sessionId;
  };

  const refreshActiveContext = async (sessionId?: string): Promise<void> => {
    const activeSessionId = syncActiveSession(sessionId);
    if (!activeSessionId) return;
    await contextRecall.refreshSession(activeSessionId, projectId);
  };

  const checkpointStore = new CheckpointStore(database.getPool(), redactor);
  const checkpointToolDeps: CheckpointToolDeps = {
    client: ctx.client,
    store: checkpointStore,
    config: config.checkpoint,
    projectId: ctx.directory ?? null,
  };
  const checkpointInjectDeps: CheckpointInjectDeps = { store: checkpointStore, config: config.checkpoint };
  const autoCheckpointCtx = { checkpointStore, config: config.checkpoint };

  const workJournal = new AgentWorkJournal(database.getPool(), config.workJournal, redactor);
  const lessonTriggers = new LessonTriggerCache(database.getPool());

  contextRecall.start();
  subconscious.start();
  gitWatcher.start();

  logging.info('AUTOMATED memory system initialized');

  const statsWriter = new StatsWriter(database.getPool());
  statsWriter.start();

  const pluginCtx: PluginContext = {
    config, database, memoryManager, contextRecall, contextPressure,
    contextCompactor, toolDistiller, loopDetector, subconscious, gitWatcher,
    memoryExtractor, primingEngine, checkpointStore, checkpointToolDeps,
    checkpointInjectDeps, redactor, statsWriter,
    client: ctx.client, directory: ctx.directory, worktree: ctx.worktree,
    autoCheckpoint: (sessionId: string, trigger: AutoCheckpointTrigger, details?: Record<string, unknown>) =>
      createAutoCheckpoint({ checkpointStore, config: config.checkpoint }, sessionId, trigger, details),
    refreshActiveContext, syncActiveSession,
    lastCompileResult: null,
    workJournal, lessonTriggers,
    state: sessionState,
  };

  return {
    event: createEventHook(ctx, pluginCtx),
    'experimental.chat.system.transform': createSystemTransformHook(pluginCtx),
    'experimental.session.compacting': createSessionCompactingHook(pluginCtx),
    'experimental.compaction.autocontinue': createAutocontinueHook(pluginCtx),
    'tool.execute.before': createToolExecuteBeforeHook(pluginCtx),
    'tool.execute.after': createToolExecuteAfterHook(pluginCtx),
    tool: registerTools(pluginCtx),
    dispose: () => disposeAll(ctx, pluginCtx),
  };
}

export { CSM_TOOL_NAMES } from './tools.js';

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
import { SubconsciousWatcher } from './subconscious.js';
import { GitWatcher } from './git-watcher.js';
import { LoopDetector } from './loop-detector.js';
import { LoopSignalDetector } from './loop-signal-detector.js';
import { LifecycleOrchestrator } from './lifecycle-orchestrator.js';
import { DecisionRegistry } from './decision-registry.js';
import { KnownDebtRegistry } from './known-debt-registry.js';
import { LintDeltaTracker } from './lint-delta-tracker.js';
import { MilestoneTracker } from './milestone-tracker.js';
import { FileContextPrimer } from './file-context-primer.js';
import { ContextPressure } from './context-pressure.js';
import { ToolCallDistiller } from './tool-distiller.js';
import { ContextCompactor } from './context-compactor.js';
import { AdaptiveContextGovernor } from './context-governor.js';
import { TokenBudgetLedger } from './token-budget-ledger.js';
import { CheckpointStore } from './checkpoint-store.js';
import { AgentWorkJournal } from './agent-work-journal.js';
import { LessonTriggerCache } from './lesson-trigger-cache.js';
import { ExperiencePacketCreator } from './experience-packet.js';
import { SelfModelUpdater } from './self-model-updater.js';
import { BeliefKnowledgeConsolidator } from './belief-knowledge-store.js';
import { LivingStateRuntime } from './living-state-runtime.js';
import { LivingStateAdvisor } from './living-state-advisor.js';
import { VcmManager } from './vcm-manager.js';
import { ContextCapSensor } from './context-cap-sensor.js';
import { BeliefPromotionScanner } from './belief-promotion-scanner.js';
import { BeliefPromotionEngine } from './belief-promotion.js';
import { StatsWriter } from './stats-writer.js';
import type { PluginContext } from './plugin-context.js';
import type { CheckpointToolDeps } from './checkpoint-tool.js';
import type { CheckpointInjectDeps } from './checkpoint-inject.js';
import type { AutoCheckpointTrigger } from './helpers/auto-checkpoint.js';
import { createAutoCheckpoint } from './helpers/auto-checkpoint.js';
import { createSystemTransformHook } from './hooks/system-transform.js';
import { createSessionCompactingHook, createAutocontinueHook } from './hooks/session-compaction.js';
import { createMessagesTransformHook } from './hooks/messages-transform.js';
import { createToolExecuteBeforeHook, createToolExecuteAfterHook } from './hooks/tool-execute.js';
import { createEventHook } from './hooks/event-hooks.js';
import { registerTools } from './hooks/tool-hooks.js';
import { disposeAll } from './hooks/dispose-hooks.js';

export async function registerHooks(
  ctx: PluginInput,
  options?: PluginOptions,
  _defaultExports: unknown = {}
): Promise<Hooks> {
  const config = validateAndReturnConfig();
  const mergedConfig = { ...config, ...(options as unknown ?? {}) };

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
  const _tokenLedger = new TokenBudgetLedger(database.getPool());
  const subconscious = new SubconsciousWatcher(memoryManager, config.subconsciousWatchInterval, config.filterBuildArtifacts);
  const gitWatcher = new GitWatcher(memoryManager, config.gitPollInterval);
  const loopDetector = new LoopDetector(config.loopDetectionThreshold);
  const loopSignalDetector = new LoopSignalDetector();
  const contextPressure = new ContextPressure(config.contextPressureRecommend, config.contextPressureDemand);
  const toolDistiller = new ToolCallDistiller(config.distiller);
  const contextCompactor = new ContextCompactor(config.compactor);
  const _contextGovernor = new AdaptiveContextGovernor(config.contextCompiler, config.contextGovernor);

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
  const _autoCheckpointCtx = { checkpointStore, config: config.checkpoint };

  const workJournal = new AgentWorkJournal(database.getPool(), config.workJournal, redactor);
  const experiencePackets = new ExperiencePacketCreator(database.getPool());
  const selfModel = new SelfModelUpdater(database.getPool(), config.selfModel);
  const beliefKnowledge = new BeliefKnowledgeConsolidator(database.getPool(), config.beliefKnowledge);
  const beliefScanner = new BeliefPromotionScanner(database.getPool());
  const beliefPromotion = new BeliefPromotionEngine(database.getPool(), memoryManager, config.beliefPromotion);
  const livingState = new LivingStateRuntime(
    database.getPool(),
    config.livingState,
    beliefScanner,
    experiencePackets,
    selfModel,
    beliefKnowledge,
    beliefPromotion,
  );
  const livingStateAdvisor = new LivingStateAdvisor(livingState, config.livingState);
  const vcmManager = new VcmManager(memoryManager, database);
  const contextCapSensor = new ContextCapSensor(config.targetContextCap);
  const lessonTriggers = new LessonTriggerCache(database.getPool());

  contextRecall.start();
  subconscious.start();
  gitWatcher.start();

  logging.info('AUTOMATED memory system initialized');

  const statsWriter = new StatsWriter(database.getPool());
  statsWriter.start();

  if (config.targetContextCap > 0) {
    logging.info(`Context cap target: ${config.targetContextCap} tokens. Set compaction.reserved in opencode.json to (model_input_limit - ${config.targetContextCap}) to enforce. Also enable compaction.prune=true for free context pruning.`);
  }

  const pluginCtx: PluginContext = {
    config, database, memoryManager, contextRecall, contextPressure,
    contextCompactor, toolDistiller, loopDetector, loopSignalDetector, subconscious, gitWatcher,
    memoryExtractor, primingEngine, embeddings, checkpointStore, checkpointToolDeps,
    checkpointInjectDeps, redactor, statsWriter,
    client: ctx.client, directory: ctx.directory, worktree: ctx.worktree,
    autoCheckpoint: (sessionId: string, trigger: AutoCheckpointTrigger, details?: Record<string, unknown>) =>
      createAutoCheckpoint({ checkpointStore, config: config.checkpoint }, sessionId, trigger, details),
    refreshActiveContext, syncActiveSession,
    lastCompileResult: null,
    workJournal, experiencePackets, lessonTriggers, selfModel, beliefKnowledge, livingState, livingStateAdvisor,
    vcmManager,
    contextCapSensor,
    state: sessionState,
  };

  const decisionRegistry = new DecisionRegistry(memoryManager);
  pluginCtx.decisionRegistry = decisionRegistry;
  const knownDebtRegistry = new KnownDebtRegistry(memoryManager);
  pluginCtx.knownDebtRegistry = knownDebtRegistry;
  const lintDeltaTracker = new LintDeltaTracker(memoryManager);
  pluginCtx.lintDeltaTracker = lintDeltaTracker;
  const milestoneTracker = new MilestoneTracker(memoryManager);
  pluginCtx.milestoneTracker = milestoneTracker;
  const fileContextPrimer = new FileContextPrimer(decisionRegistry, memoryManager, knownDebtRegistry);
  pluginCtx.fileContextPrimer = fileContextPrimer;

  const lifecycleOrchestrator = new LifecycleOrchestrator(pluginCtx);
  pluginCtx.lifecycleOrchestrator = lifecycleOrchestrator;
  lifecycleOrchestrator.start();

  return {
    event: createEventHook(ctx, pluginCtx),
    'experimental.chat.system.transform': createSystemTransformHook(pluginCtx),
    'experimental.chat.messages.transform': createMessagesTransformHook(pluginCtx),
    'experimental.session.compacting': createSessionCompactingHook(pluginCtx),
    'experimental.compaction.autocontinue': createAutocontinueHook(pluginCtx),
    'tool.execute.before': createToolExecuteBeforeHook(pluginCtx),
    'tool.execute.after': createToolExecuteAfterHook(pluginCtx),
    tool: registerTools(pluginCtx) as unknown as Hooks['tool'],
    dispose: () => disposeAll(ctx, pluginCtx),
  };
}

export { CSM_TOOL_NAMES } from './tool-names.js';

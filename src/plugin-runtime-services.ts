import type { PluginInput } from '@opencode-ai/plugin';
import { AdaptiveContextGovernor } from './context-governor.js';
import { AgentWorkJournal } from './agent-work-journal.js';
import { BeliefKnowledgeConsolidator } from './belief-knowledge-store.js';
import { AgentBookEventStore } from './agentbook-event-store.js';
import { AgentBookRulesStore } from './agentbook-rules-store.js';
import { AgentBookStateProjector } from './agentbook-state-projector.js';
import { AgentBookSummaryGenerator } from './agentbook-summary-generator.js';
import { BeliefPromotionEngine } from './belief-promotion.js';
import { BeliefPromotionScanner } from './belief-promotion-scanner.js';
import { CheckpointStore } from './checkpoint-store.js';
import { ContextCapSensor } from './context-cap-sensor.js';
import { ContextCompactor } from './context-compactor.js';
import { ContextInjectionLogger } from './context-injection-logger.js';
import { ContextPressure } from './context-pressure.js';
import { ContextRecallDaemon } from './context-recall.js';
import type { Database } from './database.js';
import { EmbeddingGenerator } from './embeddings.js';
import { ExperiencePacketCreator } from './experience-packet.js';
import { GitWatcher } from './git-watcher.js';
import { LessonTriggerCache } from './lesson-trigger-cache.js';
import { LivingStateAdvisor } from './living-state-advisor.js';
import { LivingStateRuntime } from './living-state-runtime.js';
import { LoopDetector } from './loop-detector.js';
import { LoopSignalDetector } from './loop-signal-detector.js';
import { MemoryExtractor } from './memory-extractor.js';
import { MemoryManager } from './memory-manager.js';
import { PrimingEngine } from './priming-engine.js';
import { ReEntryProtocol } from './re-entry-protocol.js';
import { Redactor } from './redactor.js';
import { SelfModelUpdater } from './self-model-updater.js';
import { SubconsciousWatcher } from './subconscious.js';
import { TokenBudgetLedger } from './token-budget-ledger.js';
import { ToolCallDistiller } from './tool-distiller.js';
import type { PluginConfig } from './types.js';
import { VcmManager } from './vcm-manager.js';
import { WorkLedger } from './work-ledger.js';

export function createCoreServices(database: Database, config: PluginConfig) {
  const embeddings = new EmbeddingGenerator(config);
  const redactor = new Redactor(config.redactor);
  const memoryManager = new MemoryManager(database, embeddings, redactor);
  void new TokenBudgetLedger(database.getPool());
  const contextGovernor = new AdaptiveContextGovernor(config.contextCompiler, config.contextGovernor);
  return {
    embeddings, redactor, memoryManager,
    memoryExtractor: new MemoryExtractor(database, memoryManager, config.extractor),
    primingEngine: new PrimingEngine(database),
    contextRecall: new ContextRecallDaemon(database, config.contextRecallInterval),
    subconscious: new SubconsciousWatcher(
      memoryManager, config.subconsciousWatchInterval, config.filterBuildArtifacts,
    ),
    gitWatcher: new GitWatcher(memoryManager, config.gitPollInterval),
    loopDetector: new LoopDetector(config.loopDetectionThreshold),
    loopSignalDetector: new LoopSignalDetector(),
    contextPressure: new ContextPressure(config.contextPressureRecommend, config.contextPressureDemand),
    toolDistiller: new ToolCallDistiller(config.distiller),
    contextCompactor: new ContextCompactor(config.compactor), contextGovernor,
  };
}

export function createPersistenceServices(
  ctx: PluginInput,
  database: Database,
  config: PluginConfig,
  core: ReturnType<typeof createCoreServices>,
) {
  const checkpointStore = new CheckpointStore(database.getPool(), core.redactor);
  const contextInjectionLogger = new ContextInjectionLogger(database.getPool(), {
    enabled: true,
    environment: process.env.NODE_ENV === 'test' ? 'fixture' : 'production',
  });
  const workJournal = new AgentWorkJournal(database.getPool(), config.workJournal, core.redactor);
  const experiencePackets = new ExperiencePacketCreator(database.getPool(), core.redactor);
  const selfModel = new SelfModelUpdater(database.getPool(), config.selfModel);
  const beliefKnowledge = new BeliefKnowledgeConsolidator(database.getPool(), config.beliefKnowledge);
  const beliefScanner = new BeliefPromotionScanner(database.getPool());
  const agentBookEvents = new AgentBookEventStore(database.getPool(), core.redactor);
  const agentBookRules = new AgentBookRulesStore(database.getPool(), core.redactor);
  const agentBookState = new AgentBookStateProjector(
    database.getPool(), agentBookEvents, core.redactor,
  );
  const agentBookSummary = new AgentBookSummaryGenerator(
    database.getPool(), agentBookEvents, core.redactor,
  );
  const workLedger = config.workLedger.enabled
    ? new WorkLedger(database.getPool(), config.workLedger) : undefined;
  return {
    checkpointStore,
    contextInjectionLogger,
    checkpointToolDeps: {
      client: ctx.client, store: checkpointStore, config: config.checkpoint, projectId: ctx.directory ?? null,
    },
    checkpointInjectDeps: { store: checkpointStore, config: config.checkpoint },
    workJournal,
    workLedger,
    experiencePackets, selfModel, beliefKnowledge,
    beliefScanner,
    agentBookEvents, agentBookRules, agentBookState, agentBookSummary,
  };
}

export function createContinuityServices(
  database: Database,
  config: PluginConfig,
  core: ReturnType<typeof createCoreServices>,
  persisted: ReturnType<typeof createPersistenceServices>,
) {
  const beliefPromotion = new BeliefPromotionEngine(
    database.getPool(), core.memoryManager, config.beliefPromotion,
  );
  const livingState = new LivingStateRuntime(
    database.getPool(), config.livingState, persisted.beliefScanner,
    persisted.experiencePackets, persisted.selfModel, persisted.beliefKnowledge, beliefPromotion,
  );
  return {
    livingState,
    livingStateAdvisor: new LivingStateAdvisor(livingState, config.livingState),
    reEntryProtocol: new ReEntryProtocol({
      pool: database.getPool(), memoryManager: core.memoryManager, selfModel: persisted.selfModel,
      beliefStore: persisted.beliefKnowledge, workJournal: persisted.workJournal, config: config.reentry,
    }),
    vcmManager: new VcmManager(core.memoryManager, database),
    contextCapSensor: new ContextCapSensor(config.targetContextCap),
    lessonTriggers: new LessonTriggerCache(database.getPool()),
  };
}

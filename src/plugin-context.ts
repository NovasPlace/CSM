/**
 * Shared context type for all hook modules.
 * Passed to each extracted hook so they can access shared state
 * without capturing closure variables from index.ts.
 */
import type { PluginInput } from '@opencode-ai/plugin';
import type { PluginConfig } from './types.js';
import type { Database } from './database.js';
import type { MemoryManager } from './memory-manager.js';
import type { ContextRecallDaemon } from './context-recall.js';
import type { ContextPressure } from './context-pressure.js';
import type { ContextCompactor } from './context-compactor.js';
import type { ToolCallDistiller } from './tool-distiller.js';
import type { LoopDetector } from './loop-detector.js';
import type { LoopSignalDetector } from './loop-signal-detector.js';
import type { SubconsciousWatcher } from './subconscious.js';
import type { GitWatcher } from './git-watcher.js';
import type { MemoryExtractor } from './memory-extractor.js';
import type { PrimingEngine } from './priming-engine.js';
import type { EmbeddingGenerator } from './embeddings.js';
import type { CheckpointStore } from './checkpoint-store.js';
import type { CheckpointToolDeps } from './checkpoint-tool.js';
import type { CheckpointInjectDeps } from './checkpoint-inject.js';
import type { AgentWorkJournal } from './agent-work-journal.js';
import type { ExperiencePacketCreator } from './experience-packet.js';
import type { LessonTriggerCache } from './lesson-trigger-cache.js';
import type { SelfModelUpdater } from './self-model-updater.js';
import type { BeliefKnowledgeConsolidator } from './belief-knowledge-store.js';
import type { AgentBookEventStore } from './agentbook-event-store.js';
import type { AgentBookRulesStore } from './agentbook-rules-store.js';
import type { AgentBookStateProjector } from './agentbook-state-projector.js';
import type { AgentBookSummaryGenerator } from './agentbook-summary-generator.js';
import type { LivingStateRuntime } from './living-state-runtime.js';
import type { LivingStateAdvisor } from './living-state-advisor.js';
import type { VcmManager } from './vcm-manager.js';
import type { ContextCapSensor } from './context-cap-sensor.js';
import type { AutoCheckpointTrigger } from './helpers/auto-checkpoint.js';
import type { CompileResult } from './context-compiler.js';
import type { Redactor } from './redactor.js';
import type { StatsWriter } from './stats-writer.js';
import type { WorkLedger } from './work-ledger.js';
import type { AdaptiveContextGovernor } from './context-governor.js';
import type { ContextInjectionLogger } from './context-injection-logger.js';

export type AutoCheckpointFn = (
  sessionId: string,
  trigger: AutoCheckpointTrigger,
  details?: Record<string, unknown>,
) => Promise<void>;

export interface PluginState {
  currentSessionId: string | null;
  runId?: string;
  currentModelId?: string;
  modelIdPinned?: boolean;
  modelIdBySession?: Map<string, string>;
  messageCount: number;
  capturedMessageSizes: Map<string, number>;
  recentUserMessages: Map<string, string>;
  sourceOnlySessions?: Set<string>;
  sourceOnlyUntilMs?: number;
  stateChangeTracker?: Record<string, unknown>;
  pendingFileContext?: import('./file-context-primer.js').FileContextBlock | null;
  pendingMilestonePrompt?: import('./milestone-tracker.js').MilestonePromptBlock | null;
  reentryInjected: Set<string>;
  onboardingInjected: Set<string>;
  reentryPending?: Set<string>;
  onboardingPending?: Set<string>;
  csmSourceAttributionLogged?: boolean;
}

export interface PluginContext {
  config: PluginConfig;
  database: Database;
  client: PluginInput['client'];
  directory: string;
  worktree?: string;
  memoryManager: MemoryManager;
  contextRecall: ContextRecallDaemon;
  contextPressure: ContextPressure;
  contextCompactor: ContextCompactor;
  contextGovernor?: AdaptiveContextGovernor;
  contextInjectionLogger?: ContextInjectionLogger;
  toolDistiller: ToolCallDistiller;
  loopDetector: LoopDetector;
  loopSignalDetector: LoopSignalDetector;
  subconscious: SubconsciousWatcher;
  gitWatcher: GitWatcher;
  memoryExtractor: MemoryExtractor;
  primingEngine: PrimingEngine;
  embeddings: EmbeddingGenerator;
  checkpointStore: CheckpointStore;
  checkpointToolDeps: CheckpointToolDeps;
  checkpointInjectDeps: CheckpointInjectDeps;
  autoCheckpoint: (sessionId: string, trigger: AutoCheckpointTrigger, details?: Record<string, unknown>) => Promise<void>;
  refreshActiveContext: (sessionId: string) => Promise<void>;
  syncActiveSession: (sessionId: string) => void;
  lastCompileResult: CompileResult | null;
  workJournal: AgentWorkJournal;
  workLedger?: WorkLedger;
  experiencePackets: ExperiencePacketCreator;
  lessonTriggers: LessonTriggerCache;
  selfModel: SelfModelUpdater;
  beliefKnowledge: BeliefKnowledgeConsolidator;
  agentBookEvents: AgentBookEventStore;
  agentBookRules: AgentBookRulesStore;
  agentBookState: AgentBookStateProjector;
  agentBookSummary: AgentBookSummaryGenerator;
  livingState: LivingStateRuntime;
  livingStateAdvisor: LivingStateAdvisor;
  reEntryProtocol?: import('./re-entry-protocol.js').ReEntryProtocol;
  decisionRegistry?: import('./decision-registry.js').DecisionRegistry;
  knownDebtRegistry?: import('./known-debt-registry.js').KnownDebtRegistry;
  lintDeltaTracker?: import('./lint-delta-tracker.js').LintDeltaTracker;
  milestoneTracker?: import('./milestone-tracker.js').MilestoneTracker;
  fileContextPrimer?: import('./file-context-primer.js').FileContextPrimer;
  lifecycleOrchestrator?: import('./lifecycle-orchestrator.js').LifecycleOrchestrator;
  vcmManager: VcmManager;
  contextCapSensor: ContextCapSensor;
  redactor: Redactor;
  statsWriter: StatsWriter;
  state: PluginState;
}

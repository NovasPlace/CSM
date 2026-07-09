// Cross-Session Memory Plugin Types
// Inspired by Agent Atlas cognitive memory engine

import type { CheckpointConfig } from './checkpoint-types.js';
import type { GovernorConfig } from './context-governor-types.js';
import type { RolloverConfig } from './context-rollover-config.js';
import type { ExtractedConcept } from './concept-extractor.js';
import type { RedactorConfig } from './redactor.js';
import type { WorkJournalConfig } from './work-journal-types.js';
import type { ReEntryConfig } from './re-entry-protocol.js';

export type MemoryType =
  | 'conversation'    // Key decisions, problems solved, user preferences
  | 'workspace'       // Project structure, code patterns, config
  | 'repo'            // Git commits, PRs, issues, code reviews
  | 'preference'      // User coding style, naming conventions
  | 'lesson'          // Lessons learned from mistakes (high importance)
  | 'episodic'        // File changes, session events (auto-captured)
  | 'procedural'      // How-to steps, learned patterns
  | 'self_continuity'; // Self-continuity observations (Phase 21)

export type MemoryCandidateStatus = 'pending' | 'approved' | 'rejected' | 'auto-approved';

export interface MemoryCandidate {
  id: string;
  sessionId: string;
  projectId: string;
  proposedType: MemoryType;
  content: string;
  importance: number;
  emotion?: MemoryEmotion;
  confidence: number;
  tags: string[];
  metadata: Record<string, unknown>;
  status: MemoryCandidateStatus;
  source: 'extractor' | 'manual';
  createdAt: Date;
  reviewedAt?: Date;
  reviewedBy?: string; // 'user' | 'system'
}

export interface MemoryApproval {
  candidateId: string;
  action: 'approve' | 'reject' | 'edit';
  editedContent?: string;
  editedType?: MemoryType;
  editedImportance?: number;
  editedTags?: string[];
  reviewedBy: 'user' | 'system';
  reviewedAt: Date;
}

export interface TTLConfig {
  enabled: boolean;
  defaultDays: number;
  byType: Partial<Record<MemoryType, number>>; // days per type
  byImportance: { min: number; max: number; days: number }[];
  gracePeriodDays: number; // min age before TTL applies
}

export interface ProjectScope {
  projectId: string;
  name: string;
  directory: string;
  createdAt: Date;
  lastActiveAt: Date;
  memoryCount: number;
}

export interface ExtractorConfig {
  enabled: boolean;
  minTurnsBeforeExtract: number;
  maxCandidatesPerTurn: number;
  confidenceThreshold: number;
  autoApproveThreshold: number; // confidence >= this = auto-approve
  model?: string; // LLM model for extraction
}

export type MemoryEmotion =
  | 'neutral'
  | 'frustration' // Negativity bias for lessons
  | 'success'
  | 'curiosity'
  | 'concern';

export type MemorySource =
  | 'manual'       // User explicitly saved
  | 'auto'         // Auto-captured by system
  | 'subconscious' // File changes, symbol extraction
  | 'git'          // Git commits
  | 'lesson';      // Learned from mistakes

export type SortBy = 'recent' | 'important' | 'accessed';

export type MemorySearchMode = 'project' | 'legacy' | 'global';

export interface Session {
  id: string;
  projectId?: string;
  workspaceId?: string;
  directory?: string;
  title: string;
  summary?: string;
  turnCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Memory {
  id: number;
  sessionId?: string;
  projectId?: string;
  memoryType: MemoryType;
  content: string;
  importance: number;
  emotion: MemoryEmotion;
  confidence: number;
  source: MemorySource;
  tags: string[];
  linkedMemoryIds: number[];
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  accessedAt: Date;
  accessCount: number;
    lastAccessedAt?: Date;
    archivedAt?: Date;
    recallCount?: number;
    graphLinks?: number;
    qualityScore?: number;
  }

export interface MemoryChunk {
  id: number;
  memoryId: number;
  chunkIndex: number;
  content: string;
  tokenCount: number;
  embedding: number[];
  embeddingModel: string;
  createdAt: Date;
}

export interface MemoryEvent {
  id: number;
  channel: string;
  payload: Record<string, unknown>;
  sessionId?: string;
  createdAt: Date;
}

export interface SessionContext {
  id: number;
  sessionId: string;
  projectId?: string;
  contextBrief: string;
  episodicMemories: Memory[];
  proceduralMemories: Memory[];
  semanticMemories: Memory[];
  builtAt: Date;
  expiresAt: Date;
}

export type BudgetMode = 'cheap' | 'normal' | 'deep';

export interface ContextCompilerConfig {
  enabled: boolean;
  modes: Record<BudgetMode, number>;
  defaultMode: BudgetMode;
  recentTurnWindow: number;
  // Layer 1: status line injection
  statusInjection: boolean;
  statusPlacement: 'end' | 'start';
  statusVerbosity: 'compact' | 'verbose';
  // Layer 3: compilation log retention
  logEnabled: boolean;
  logSummaryRetentionDays: number | null; // null = forever
  logDetailsRetentionDays: number;         // prune JSONB details after N days
  storeRawCompressedContent: boolean;      // never store raw content
}

/** Phase 6: Context cache configuration */
export interface ContextCacheConfig {
  enabled: boolean;
  minTokensToCache: number;    // minimum estimated tokens to cache an item
  manifestMaxTokens: number;   // max tokens for manifest in system prompt
  retentionDays: number;       // prune cache items older than N days
}

/** Per-part compression detail with risk label and preserved signals */
export interface CompressedPartDetail {
  kind: string;           // 'tool_read', 'tool_bash', 'tool_edit', 'assistant_text'
  source: string;         // file path or command
  reason: string;         // 'large_read_output', 'old_tool_output', etc.
  beforeTokens: number;
  afterTokens: number;
  compressionRatio: number;
  preservedSignals: string[];
  risk: 'low' | 'medium' | 'high';
}

/** DB row for context_compilation_log table */
export interface ContextCompilationEntry {
  id: number;
  sessionId: string;
  createdAt: Date;
  mode: BudgetMode;
  budget: number;
  beforeTokens: number;
  afterTokens: number;
  partsCompressed: number;
  partsPinned: number;
  compressedDetails: CompressedPartDetail[] | null;
  pinnedCategories: Record<string, number> | null;
}

export interface ProviderPricing {
  inputPerMtok: number;
  outputPerMtok: number;
  cacheWritePerMtok: number;
  cacheReadPerMtok: number;
}

export interface CompactionReport {
  sessionId: string;
  cycleId: string;
  timestamp: Date;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  reductionPercent: number;
  toolTokensBefore: number;
  toolTokensAfter: number;
  toolDominanceBefore: number;
  toolDominanceAfter: number;
  compressionCount: number;
  unsafeCompactionsRejected: number;
  qualityScore: number;
  estimatedCostSaved: number;
  effectiveContextMultiplier: number;
  budgetMode: BudgetMode;
  budget: number;
  pressureRatio: number;
  details: CompressedPartDetail[] | null;
  providerPricing?: ProviderPricing;
}

export interface ToolDominanceTrendPoint {
  cycle: number;
  before: number;
  after: number;
}

export interface SessionAnalytics {
  sessionId: string;
  totalCycles: number;
  totalTokensSaved: number;
  totalCostSaved: number;
  totalUnsafeRejected: number;
  avgQualityScore: number;
  avgReductionPercent: number;
  peakPressureRatio: number;
  effectiveContextMultiplier: number;
  toolDominanceTrend: ToolDominanceTrendPoint[];
  reports: CompactionReport[];
}

export interface AutoDocsConfig {
  enabled: boolean;
  ignoredPaths: string[];
  maxChangelogEntriesPerSession: number;
  maxEntryLength: number;
  deduplicateEdits: boolean;
  groupMultipleEdits: boolean;
}

export type DatabaseProvider = 'postgres' | 'sqlite';

export interface PluginConfig {
  databaseUrl: string;
  databaseProvider: DatabaseProvider;
  sqlitePath: string;
  embeddingModel: string;
  embeddingApiKey?: string;
  embeddingApiUrl?: string;
  maxMemoriesPerRecall: number;
  importanceThreshold: number;
  autoStoreConversations: boolean;
  fullTranscripts: boolean; // Store full conversation transcripts
  contextRecallInterval: number; // seconds
  subconsciousWatchInterval: number; // seconds
  gitPollInterval: number; // seconds
  contextPressureRecommend: number; // 0-1
  contextPressureDemand: number; // 0-1
  targetContextCap: number; // target context window cap in tokens (for CSM injection trimming)
  loopDetectionThreshold: number;
  // Noise reduction flags (default: false to suppress junk)
  logToolUsage: boolean;       // Log "Tool used: X" episodic memories
  logCommands: boolean;        // Log "Command executed: X" procedural memories
  logSessionLifecycle: boolean; // Log session started/ended episodic memories
  filterBuildArtifacts: boolean; // Filter node_modules, .map, dist/, out/ in subconscious
  promptDebug: boolean;        // Write prompt-debug logs to .opencode/prompt-debug/
  // New write path configs
  extractor: ExtractorConfig;
  ttl: TTLConfig;
  // Tool call distiller config
  distiller: DistillerConfig;
  // Context compactor config
  compactor: CompactorConfig;
  // Assistant text compactor config
  assistantCompactor: AssistantCompactorConfig;
  // Phase 4A — Durable session checkpointing
  checkpoint: CheckpointConfig;
  // Phase 5 — Context compiler (input token governor)
  contextCompiler: ContextCompilerConfig;
  contextGovernor?: GovernorConfig;
  contextCache: ContextCacheConfig;
  // Phase 6 — Context rollover (cumulative token tracker + soft rollover)
  contextRollover: RolloverConfig;
  // Phase 3 — Auto-docs noise guard
  autoDocs: AutoDocsConfig;
  // Phase 18 — Privacy/redaction layer
  redactor: RedactorConfig;
  // Phase 21 — Self-continuity records
  selfContinuity: SelfContinuityConfig;
  // Agent work journal — live incremental capture of agent's work state
  workJournal: WorkJournalConfig;
  // Phase 4D — Self model capability tracking
  selfModel: SelfModelConfig;
  // Phase 4E — Belief knowledge
  beliefKnowledge: BeliefKnowledgeConfig;
  // Phase 4G — Belief promotion pipeline
  beliefPromotion: BeliefPromotionConfig;
  // Phase 4F — Living state runtime loop
  livingState: LivingStateConfig;
  // Phase 8B — Re-entry live enablement
  reentry: ReEntryConfig;
}

export type { BucketBreakdown } from './token-bucket-analyzer.js';

export interface CompactorConfig {
  enabled: boolean;
  workingMemoryWindow: number;  // keep last N tool parts raw (default 8)
  minAgeMs: number;              // don't compact tool parts newer than this (default 60000)
  maxOutputChars: number;        // truncate compacted output to this many chars (default 120)
  truncateInput: boolean;        // also truncate large input args for old calls
  // Tool-call budget cap
  budgetCapEnabled: boolean;     // enable budget cap enforcement
  budgetCapPercent: number;      // max % of context from tool calls (default 30)
  budgetCapPressureThreshold: number; // context pressure 0-1 to trigger aggressive compaction
  budgetCapMaxIterations: number; // max compaction iterations per pass (default 3)
}

export interface AssistantCompactorConfig {
  enabled: boolean;
  workingAssistantWindow: number;  // keep last N assistant messages raw (default 2)
  minTokens: number;               // don't compress text parts under this token count (default 200)
  maxOutputChars: number;          // max chars for compressed output (default 600)
}

export interface CompactionResult {
  totalToolParts: number;
  compactedParts: number;
  keptRawParts: number;
  skippedParts: number;
  beforeChars: number;
  afterChars: number;
  beforeTokens: number;
  afterTokens: number;
  tokensSaved: number;
  savedPercent: number;
  semanticSignalCountPreserved: number;
  compactedAt: Date;
}

export interface CumulativeCompactionStats {
  totalCompactions: number;
  totalPartsCompacted: number;
  totalTokensSaved: number;
  totalSemanticSignalsPreserved: number;
  firstCompactedAt: Date | null;
  lastCompactedAt: Date | null;
  }

  export interface CompactionQualityMetrics {
    compressionRatio: number;
    embeddingDrift: number;
    entityRetention: number;
    decisionRetention: number;
    warningErrorRetention: number;
    restoreSuccessRate: number;
    recallSuccessAfterCompaction: number;
    tokensSavedTotal: number;
    tokensSavedPerSession: number;
    qualityScore: number;
    safe: boolean;
    entitiesBefore: string[];
    entitiesAfter: string[];
    decisionsBefore: string[];
    decisionsAfter: string[];
    warningsErrorsBefore: string[];
    warningsErrorsAfter: string[];
  }

  export interface CompactionQualityConfig {
    entityRetentionWeight: number;
    decisionRetentionWeight: number;
    warningErrorRetentionWeight: number;
    semanticSimilarityWeight: number;
    qualityThreshold: number;
    embeddingDriftWarningThreshold: number;
  }

  export const DEFAULT_COMPACTION_QUALITY_CONFIG: CompactionQualityConfig = {
      entityRetentionWeight: 0.35,
      decisionRetentionWeight: 0.25,
      warningErrorRetentionWeight: 0.25,
      semanticSimilarityWeight: 0.15,
      qualityThreshold: 0.6,
      embeddingDriftWarningThreshold: 0.3,
    };

  export interface DistillerConfig {
  enabled: boolean;
  groupWindowMs: number;       // Max ms between calls to group together (default 30000)
  maxSummaryLength: number;    // Max chars per summary (default 200)
  maxContextSummaries: number; // Max summaries to show in context pane (default 10)
  minCallsForGroup: number;    // Min calls before producing a group summary (default 2)
  autoSaveAsMemory: boolean;   // Auto-save distilled summaries as procedural/episodic memories
}

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  output: string;
  error?: string;
  exitCode?: number;
  timestamp: number;
  sessionId: string;
  filePath?: string;           // Extracted from args if it's a file operation
}

export interface ToolCallGroup {
  id: string;
  intent: string;              // e.g., "debug auth flow", "implement dark mode"
  toolCalls: ToolCallRecord[];
  filesChanged: string[];
  commandsRun: string[];
  outcome: 'success' | 'failure' | 'partial' | 'unknown';
  errorSummary?: string;
  fixApplied?: string;
  proceduralInsight?: string;
  timestamp: number;
}

export interface ToolCallSummary {
  id: string;
  sessionId: string;
  groups: ToolCallGroup[];
  compressed: string;          // ≤50 line context-brief-compatible string
  totalCallsSummarized: number;
  builtAt: Date;
}

export interface ContextBrief {
  episodic: Memory[];
  procedural: Memory[];
  semantic: Memory[];
  distilled?: ToolCallGroup[]; // Distilled tool-call activity for context pane
  compressed: string; // <=50 lines
}

export interface LoopDetectionResult {
  loop: boolean;
  callCount: number;
  mayday?: string;
}

export interface ContextPressureResult {
  action: 'ok' | 'recommend_flush' | 'urgent_flush';
  estimatedTokens: number;
  pressure: number; // 0-1
}

export interface RecallResult {
  memories: Memory[];
  scores: number[];
  contextBrief?: ContextBrief;
}

export interface MemorySaveOptions {
  content: string;
  type: MemoryType;
  importance?: number;
  emotion?: MemoryEmotion;
  confidence?: number;
  source?: MemorySource;
  tags?: string[];
  linkedMemoryIds?: number[];
  metadata?: Record<string, unknown>;
  sessionId?: string;
  projectId?: string;
}

export interface MemorySearchOptions {
  query: string;
  type?: MemoryType;
  limit?: number;
  minImportance?: number;
  tags?: string[];
  projectId?: string;
  searchMode?: MemorySearchMode;
}

export interface MemoryListOptions {
  type?: MemoryType;
  limit?: number;
  sortBy?: SortBy;
  tags?: string[];
  projectId?: string;
  searchMode?: MemorySearchMode;
  entityType?: ExtractedConcept["type"];
  entityValue?: string;
  sessionId?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

export interface BackfillEmbeddingsOptions {
  limit: number;
  projectId?: string;
  dryRun?: boolean;
}

export interface BackfillEmbeddingsResult {
  scanned: number;
  eligible: number;
  updated: number;
  skipped: number;
  failed: number;
}

export interface DatabasePool {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
  connect: () => Promise<DatabaseClient>;
  end: () => Promise<void>;
  /** Returns the SQL dialect. Defaults to 'pg' when not implemented (e.g. raw pg.Pool). */
  getDialect?: () => 'pg' | 'sqlite';
}

/** Transactional client acquired via pool.connect(); release() returns it to the pool. */
export interface DatabaseClient {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
  release: () => void;
}

export type PruneRiskLevel = 'low' | 'medium' | 'high';

export interface PruneSignal {
  ageDays: number;
  importance: number;
  recallCount: number;
  graphLinks: number;
  entityDensity: number;
  qualityScore: number;
  sessionRelevance: number;
}

export interface PruneCandidate {
  memoryId: number;
  action: 'would_archive';
  riskLevel: PruneRiskLevel;
  reason: string;
  tokensSaved: number;
  signals: PruneSignal;
  protected: boolean;
  protectionReasons: string[];
}

export interface PruneReport {
  candidates: PruneCandidate[];
  totalCandidates: number;
  totalTokensSaved: number;
  riskDistribution: { low: number; medium: number; high: number };
  protectedCount: number;
  prunableCount: number;
  dryRun: boolean;
}

export interface PruneConfig {
  dryRun: boolean;
  maxAgeDays: number;
  minImportanceThreshold: number;
  minRecallCountForProtection: number;
  minGraphLinksForProtection: number;
  recentAccessDays: number;
  qualityScoreThreshold: number;
  maxCandidates: number;
  ageWeight: number;
  importanceWeight: number;
  recallWeight: number;
  graphWeight: number;
  entityDensityWeight: number;
  sessionRelevanceWeight: number;
  qualityWeight: number;
  protectedPenalty: number;
  threshold: number;
}

export type AlchemistLessonType =
  | 'verified_pattern'
  | 'anti_pattern'
  | 'repair_recipe'
  | 'risk_rule'
  | 'validation_checklist'
  | 'procedure';

export type AlchemistSource =
  | 'repo_scan'
  | 'session_trace'
  | 'test_failure'
  | 'system_map'
  | 'agent_session'
  | 'tool_trace'
  | 'verification_result';

export interface AlchemistIngest {
  source: AlchemistSource;
  content: string;
  metadata: Record<string, unknown>;
  timestamp: Date;
}

export interface ExtractedCapability {
  name: string;
  type: 'feature' | 'pattern' | 'anti_pattern' | 'gap' | 'risk' | 'risk_rule';
  evidence: string;
  file?: string;
  line?: number;
  confidence: number;
}

export interface LessonTelemetry {
  hits: number;
  misses: number;
  tokensUsed: number;
  lessonsQueried: number;
}

export interface AlchemistLesson {
  id: string;
  type: AlchemistLessonType;
  title: string;
  description: string;
  trigger: string;
  action: string;
  evidence: string[];
  source: AlchemistSource;
  verified: boolean;
  verificationCount: number;
  confidence: number;
  retention: number;
  lastVerified?: Date;
  createdAt: Date;
  tags: string[];
}

export interface Blueprint {
  id: string;
  lessons: string[];
  procedures: string[];
  riskRules: string[];
  targetContext: string;
  generatedAt: Date;
}

export interface GapReport {
  systemName: string;
  capabilities: string[];
  missing: ExtractedCapability[];
  risks: ExtractedCapability[];
  antipatterns: ExtractedCapability[];
  gaps: ExtractedCapability[];
}

export interface AlchemistConfig {
  organismManifest: string[];
  verificationThreshold: number;
  maxLessons: number;
  autoVerify: boolean;
  recallTopK: number;
}

export interface SelfContinuityConfidenceWeights {
  recalledSessions: number;    // 0.30
  evidenceAnchors: number;     // 0.25
  goalContinuity: number;      // 0.20
  selfSummarySimilarity: number; // 0.15
  selfAssessment: number;      // 0.10
}

export interface SelfContinuityConfig {
  enabled: boolean;
  maxRecordsPerSession: number;
  maxRecordsToInject: number;
  maxInjectTokens: number;
  confidenceWeights: SelfContinuityConfidenceWeights;
  injectionTriggers: string[];
  injectionMode: 'silent' | 'instrumented';
  deepContinuity?: {
    enabled: boolean;
    maxThreadsToInject: number;
    maxInjectTokens: number;
    triggerKeywords: string[];
    injectionMode: 'deep' | 'deep-silent';
  };
}

export type CapabilityName =
  | 'tool_use'
  | 'code_editing'
  | 'test_repair'
  | 'schema_migration'
  | 'memory_recall'
  | 'loop_recovery'
  | 'prompt_injection_detection'
  | 'context_budgeting';

export const ALL_CAPABILITIES: CapabilityName[] = [
  'tool_use',
  'code_editing',
  'test_repair',
  'schema_migration',
  'memory_recall',
  'loop_recovery',
  'prompt_injection_detection',
  'context_budgeting',
];

export interface EvidenceRef {
  packetId: number;
  entryType: string;
  outcome: 'success' | 'failure' | 'mixed';
  toolName?: string;
  timestamp: string;
}

export interface SelfModelCapability {
  id?: number;
  capability: CapabilityName;
  confidence: number;
  uncertainty: number;
  evidenceRefs: EvidenceRef[];
  successCount: number;
  failureCount: number;
  driftWarning: boolean;
  lastVerified: string | null;
  updatedAt: string;
}

export interface SelfModelConfig {
  enabled: boolean;
  updateIntervalMs: number;
  confidenceIncrementRate: number;
  uncertaintyIncrementRate: number;
  contradictionPenalty: number;
  driftWarningThreshold: number;
}

export type BeliefKind = 'preference' | 'opinion' | 'worldview';

export type BeliefStance = 'supports' | 'opposes' | 'neutral';

export type BeliefStatus = 'candidate' | 'promoted' | 'rejected' | 'stale';

export interface BeliefEntry {
  id?: number;
  beliefKind: BeliefKind;
  subject: string;
  claim: string;
  stance: BeliefStance;
  confidence: number;
  uncertainty: number;
  evidenceRefs: EvidenceRef[];
  contradictedCount: number;
  lastReinforcedAt: string | null;
  status: BeliefStatus;
  createdAt: string;
  updatedAt: string;
}

export interface BeliefKnowledgeConfig {
  enabled: boolean;
  consolidationIntervalMs: number;
  confidenceThreshold: number;
  uncertaintyThreshold: number;
}

export interface BeliefPromotionConfig {
  enabled: boolean;
  dryRunByDefault: boolean;
  minConfidence: number;
  minReinforcement: number;
  minEvidenceRefs: number;
  minSessions: number;
  maxPromotePerRun: number;
  relaxed: boolean;
}

export interface LivingStateConfig {
  enabled: boolean;
  previewOnly: boolean;
  injectAdvisoryBlock: boolean;
  maxAdvisoryBlockChars: number;
  scanLookbackMinutes: number;
  maxScanPerType: number;
  updateIntervalMs: number;
}

export const DEFAULT_PRUNE_CONFIG: PruneConfig = {
  dryRun: true,
  maxAgeDays: 90,
  minImportanceThreshold: 0.3,
  minRecallCountForProtection: 3,
  minGraphLinksForProtection: 3,
  recentAccessDays: 7,
  qualityScoreThreshold: 0.6,
  maxCandidates: 100,
  ageWeight: 0.2,
  importanceWeight: 0.25,
  recallWeight: 0.2,
  graphWeight: 0.15,
  entityDensityWeight: 0.05,
  sessionRelevanceWeight: 0.05,
  qualityWeight: 0.1,
  protectedPenalty: 0.1,
  threshold: 0.5,
};

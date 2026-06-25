// Cross-Session Memory Plugin Types
// Inspired by Agent Atlas cognitive memory engine

import type { CheckpointConfig } from './checkpoint-types.js';
import type { RolloverConfig } from './context-rollover-config.js';

export type MemoryType =
  | 'conversation' // Key decisions, problems solved, user preferences
  | 'workspace'    // Project structure, code patterns, config
  | 'repo'         // Git commits, PRs, issues, code reviews
  | 'preference'   // User coding style, naming conventions
  | 'lesson'       // Lessons learned from mistakes (high importance)
  | 'episodic'     // File changes, session events (auto-captured)
  | 'procedural';  // How-to steps, learned patterns

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

export interface AutoDocsConfig {
  enabled: boolean;
  ignoredPaths: string[];
  maxChangelogEntriesPerSession: number;
  maxEntryLength: number;
  deduplicateEdits: boolean;
  groupMultipleEdits: boolean;
}

export interface PluginConfig {
  databaseUrl: string;
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
  loopDetectionThreshold: number;
  // Noise reduction flags (default: false to suppress junk)
  logToolUsage: boolean;       // Log "Tool used: X" episodic memories
  logCommands: boolean;        // Log "Command executed: X" procedural memories
  logSessionLifecycle: boolean; // Log session started/ended episodic memories
  filterBuildArtifacts: boolean; // Filter node_modules, .map, dist/, out/ in subconscious
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
  contextCache: ContextCacheConfig;
  // Phase 6 — Context rollover (cumulative token tracker + soft rollover)
  contextRollover: RolloverConfig;
  // Phase 3 — Auto-docs noise guard
  autoDocs: AutoDocsConfig;
}

export interface CompactorConfig {
  enabled: boolean;
  workingMemoryWindow: number;  // keep last N tool parts raw (default 8)
  minAgeMs: number;              // don't compact tool parts newer than this (default 60000)
  maxOutputChars: number;        // truncate compacted output to this many chars (default 120)
  truncateInput: boolean;        // also truncate large input args for old calls
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
}

export interface MemorySearchOptions {
  query: string;
  type?: MemoryType;
  limit?: number;
  minImportance?: number;
  tags?: string[];
}

export interface MemoryListOptions {
  type?: MemoryType;
  limit?: number;
  sortBy?: SortBy;
  tags?: string[];
}

export interface DatabasePool {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
  connect: () => Promise<DatabaseClient>;
  end: () => Promise<void>;
}

/** Transactional client acquired via pool.connect(); release() returns it to the pool. */
export interface DatabaseClient {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
  release: () => void;
}

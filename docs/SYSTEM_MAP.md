# System Map

> Auto-generated architecture reference. Updated on file edits via `auto-docs` hook.

## Core

| File | Exports | Type | Role |
|------|---------|------|------|
| `src/self-continuity-types.ts` | SelfContinuityTriggerType, SimilarityMethod, DriftLevel, IdentityDrift, SelfContinuityRecord, InjectionMode, SelfContinuityDebugTelemetry, ContinuityConfidenceInput, CONTINUITY_CONFIDENCE_WEIGHTS, SelfContinuityConfig, DEFAULT_SELF_CONTINUITY_CONFIG | source | Module |
| `src/self-continuity-schema.ts` | initializeSelfContinuitySchema | source | SQL schema |
| `src/self-continuity-generator.ts` | SelfContinuityGenerator | source | Module |
| `src/benchmark.ts` | authenticate, runBenchmarkSuite | source | Module |
| `src/redactor.ts` | RedactCategory, PathMode, RedactorConfig, RedactionAudit, RedactionResult, DEFAULT_REDACTOR_CONFIG, Redactor, redact, redactObject | source | Module |
| `src/alchemist.ts` | DEFAULT_ALCHEMIST_CONFIG, AlchemistEngine | source | Module |
| `src/types/opentui.d.ts` | createSignal, createEffect, onCleanup, createMemo, onMount, h, jsx, jsxs, Fragment, RGBA, Renderable, KeyEvent, SlotMode, CliRenderer, JSX, SolidPlugin, Binding, Keymap, KeyLike, KeySequencePart, KeyStringifyInput, StringifyOptions, stringifyKeySequence, stringifyKeyStroke, BindingConfig, BindingLookup, BindingValue, createBindingLookup, formatCommandBindings, formatKeySequence | types | Module |
| `src/index.ts` | none | source | Module |
| `src/plugin-context.ts` | AutoCheckpointFn, PluginState, PluginContext | source | Module |
| `src/config.ts` | DEFAULT_CONFIG | source | Configuration |
| `src/types.ts` | MemoryType, MemoryCandidateStatus, MemoryCandidate, MemoryApproval, TTLConfig, ProjectScope, ExtractorConfig, MemoryEmotion, MemorySource, SortBy, MemorySearchMode, Session, Memory, MemoryChunk, MemoryEvent, SessionContext, BudgetMode, ContextCompilerConfig, ContextCacheConfig, CompressedPartDetail, ContextCompilationEntry, ProviderPricing, CompactionReport, ToolDominanceTrendPoint, SessionAnalytics, AutoDocsConfig, PluginConfig, CompactorConfig, AssistantCompactorConfig, CompactionResult, CumulativeCompactionStats, CompactionQualityMetrics, CompactionQualityConfig, DEFAULT_COMPACTION_QUALITY_CONFIG, DistillerConfig, ToolCallRecord, ToolCallGroup, ToolCallSummary, ContextBrief, LoopDetectionResult, ContextPressureResult, RecallResult, MemorySaveOptions, MemorySearchOptions, MemoryListOptions, BackfillEmbeddingsOptions, BackfillEmbeddingsResult, DatabasePool, DatabaseClient, PruneRiskLevel, PruneSignal, PruneCandidate, PruneReport, PruneConfig, AlchemistLessonType, AlchemistSource, AlchemistIngest, ExtractedCapability, LessonTelemetry, AlchemistLesson, Blueprint, GapReport, AlchemistConfig, SelfContinuityConfidenceWeights, SelfContinuityConfig, DEFAULT_PRUNE_CONFIG | source | Context compaction engine |
| `src/tools.ts` | memorySaveTool, memorySearchTool, memoryDeleteTool, memoryContextTool, memoryLessonTool, memoryListTool, memoryTranscriptTool, memoryCandidateListTool, memoryCandidateApproveTool, memoryCandidateRejectTool, memoryProjectListTool, memoryCleanupTool, memoryDistillTool, memoryDistilledViewTool, memoryCompactTool | source | Tool registration |
| `src/database.ts` | Database | source | PostgreSQL connection & schema |
| `src/embeddings.ts` | EMBEDDING_DIMENSIONS, EmbeddingChunk, EmbeddingConfig, EmbeddingGenerator | source | Module |
| `src/maintenance-tools.ts` | memoryBackfillEmbeddingsTool | source | Tool registration |
| `src/bridge-ops.ts` | BridgeDeps, BridgeContext, ContextBriefPayload, CompactionReportPayload, saveMemoryOp, searchMemoriesOp, listMemoriesOp, recallLessonsOp, getContextBriefOp, pruneMemoriesDryRunOp, backfillMissingEmbeddingsOp, getCompactionReportOp | source | Context compaction engine |
| `src/codex-bridge.ts` | CodexMemoryBridge | source | Memory & recall subsystem |
| `src/memory-manager.ts` | MemoryManager | source | Memory & recall subsystem |
| `src/memory-graph.ts` | MemoryLink, RelatedMemory, initializeGraphSchema, inferLinkType, buildLinksForMemory, getRelatedMemories, findSharedEntities | source | Memory & recall subsystem |
| `src/memory-extractor.ts` | MemoryExtractor | source | Memory & recall subsystem |
| `src/recall-telemetry.ts` | RecallTelemetrySource, RecallTelemetryInput, initializeRecallTelemetrySchema, hashRecallQuery, recordRecallBatch, getRecallCounts | source | Memory & recall subsystem |
| `src/concept-extractor.ts` | ExtractedConcept, ExtractionResult, extractConcepts, mergeConcepts | source | Module |
| `src/hybrid-search.ts` | HybridWeights, ftsSearch, vectorSearch, entityMatchBoost, reciprocalRankFusion, applyWeights, hybridSearch | source | Module |
| `src/compaction-quality.ts` | extractEntities, extractDecisions, extractWarningsErrors, computeRetention, computeCompressionRatio, computeQualityScore, measureCompactionQuality, cosineSimilarity | source | Context compaction engine |
| `src/prune-scorer.ts` | pruneMemories, computeAgeDays_, computeEntityDensity_, isProtectedMemory_, computePruneScore_, buildReason_, classifyRisk_, buildPruneReport_ | source | Memory & recall subsystem |

## Context Pipeline

| File | Exports | Type | Role |
|------|---------|------|------|
| `src/context-compiler.ts` | CompileResult, formatLessonBlock, compileContextWithLessons, scoreCriticality, compileContext, formatStatusLine | source | Module |
| `src/context-compactor.ts` | ContextCompactor, createContextCompactor | source | Context compaction engine |
| `src/context-pressure.ts` | Message, ContextPressure | source | Module |
| `src/context-recall.ts` | ContextRecallDaemon | source | Memory & recall subsystem |
| `src/context-rollover.ts` | RolloverResult, performRollover | source | Module |
| `src/context-rollover-config.ts` | RolloverConfig, DEFAULT_ROLLOVER_CONFIG | source | Configuration |
| `src/context-rollover-brief.ts` | ContinuationBrief, buildContinuationBrief | source | Module |
| `src/context-rollover-schema.ts` | initializeRolloverSchema, RolloverRecord, getRolloverRecord, upsertCumulativeTokens, recordRollover, setHardRolloverFlag, clearHardRolloverFlag | source | SQL schema |
| `src/context-compilation-log.ts` | logCompilation, getRecentCompilation, getCompilationHistory, pruneOldDetails | source | Module |
| `src/context-compilation-schema.ts` | initializeContextCompilationSchema | source | SQL schema |
| `src/compaction-analytics.ts` | DEFAULT_PROVIDER_PRICING, CompactionAnalytics | source | Context compaction engine |

## Context Cache

| File | Exports | Type | Role |
|------|---------|------|------|
| `src/context-cache-store.ts` | CacheKind, CacheItemInput, CacheItem, storeItem, fetchItem, searchItems, fetchFileReads, fetchLastError, fetchDecisions, countItems, pruneOldItems | source | Module |
| `src/context-cache-runtime.ts` | CacheRuntimeConfig, CacheRuntimeResult, cacheOldContext | source | Module |
| `src/context-cache-manifest.ts` | ManifestEntry, ManifestResult, buildManifestFromRows, buildManifest | source | Module |
| `src/context-cache-tools.ts` | ContextCacheToolDeps, contextFetchTool, contextSearchTool, contextFetchFileRegionTool, contextFetchLastErrorTool, contextFetchDecisionLogTool | source | Tool registration |
| `src/context-cache-schema.ts` | initializeContextCacheSchema | source | SQL schema |
| `src/context-review-tool.ts` | ContextReviewDeps, contextReviewTool | source | Tool registration |

## Checkpoint System

| File | Exports | Type | Role |
|------|---------|------|------|
| `src/checkpoint-builder.ts` | BuildInput, BuildResult, buildCheckpoint | source | Module |
| `src/checkpoint-capture.ts` | collectRawCaptures, estimateInputTokens | source | Module |
| `src/checkpoint-inject.ts` | CheckpointInjectDeps, buildCheckpointInjection | source | Module |
| `src/checkpoint-store.ts` | CheckpointStore | source | Module |
| `src/checkpoint-schema.ts` | CHECKPOINT_SCHEMA_VERSION, initializeCheckpointSchema | source | SQL schema |
| `src/checkpoint-markdown.ts` | CheckpointSections, buildCheckpointMarkdown | source | Module |
| `src/checkpoint-telemetry.ts` | CheckpointCreatedEvent, CheckpointExpandedEvent, CheckpointListedEvent, CheckpointInjectedEvent, logCheckpointCreated, logCheckpointExpanded, logCheckpointListed, logCheckpointInjected, logCheckpointError | source | Module |
| `src/checkpoint-tool.ts` | CheckpointToolDeps, createCheckpointTool, expandCheckpointRefTool, listCheckpointsTool | source | Tool registration |
| `src/checkpoint-types.ts` | RawCaptureKind, SourceRef, CompactedRef, RawCaptureRecord, StoreRawInput, CheckpointRecord, CreateCheckpointInput, CheckpointTelemetry, ExpandedRef, CheckpointConfig, AutoCheckpointConfig, SessionMessage, SessionPart | source | Module |

## Compaction Helpers

| File | Exports | Type | Role |
|------|---------|------|------|
| `src/compaction-utils.ts` | hasOpenCodeDiscardMarker, isAlreadyCompacted, adaptiveWindow, isRecentEnough, collectToolParts, extractCriticalSignals, findMatchingGroup, extractFile, truncateInput, measureTotalChars | source | Module |
| `src/compaction-types.ts` | ToolPartLike, ToolPartLocation | source | Module |
| `src/compaction-tracker.ts` | ReprocessingEntry, CompactionTracker | source | Context compaction engine |
| `src/helpers/compaction-metrics.ts` | recordCompactionMetric, hasToolDiscardMarker | helpers | Context compaction engine |
| `src/helpers/auto-checkpoint.ts` | AutoCheckpointTrigger, AutoCheckpointContext, createAutoCheckpoint | helpers | Module |

## Hooks

| File | Exports | Type | Role |
|------|---------|------|------|
| `src/hooks/auto-docs.ts` | DEFAULT_AUTO_DOCS_CONFIG, queueDocUpdate, isIgnoredPath, flushDocUpdates, clearPendingUpdates, getPendingUpdates, resetFlushedFlag | hooks | Hook handler |
| `src/hooks/doc-analyzer.ts` | isIgnoredForAnalysis, isStubContent, updateDocContent, shouldSkipEntry, autoDocumentChange, reconcileSystemMap | hooks | Hook handler |
| `src/hooks/tool-execute.ts` | createToolExecuteBeforeHook, createToolExecuteAfterHook | hooks | Hook handler |
| `src/hooks/session-compaction.ts` | createSessionCompactingHook, createAutocontinueHook | hooks | Hook handler |
| `src/hooks/system-transform.ts` | createSystemTransformHook | hooks | Hook handler |

## Other Subsystems

| File | Exports | Type | Role |
|------|---------|------|------|
| `src/goal-schema.ts` | Goal, initializeGoalSchema, setActiveGoal, updateGoal, getActiveGoal, listGoals | source | SQL schema |
| `src/goal-tools.ts` | GoalToolDeps, goalSetTool, goalUpdateTool, goalListTool | source | Tool registration |
| `src/git-watcher.ts` | GitCommit, GitRepoState, GitWatcher | source | Module |
| `src/loop-detector.ts` | ToolCall, LoopDetector | source | Module |
| `src/priming-engine.ts` | CascadeResult, PrimingEngine | source | Module |
| `src/subconscious.ts` | FileChangeEvent, SubconsciousWatcher | source | Module |
| `src/token-bucket-analyzer.ts` | BucketBreakdown, estimateTokens, estimatePartTokens, analyzeMessages, estimateSystemPrompt, formatBreakdown | source | Module |
| `src/tool-distiller.ts` | ToolCallDistiller | source | Tool registration |
| `src/tui.ts` | none | source | Module |
| `src/assistant-text-compactor.ts` | AssistantCompactorConfig, AssistantCompactionResult, compactAssistantText | source | Context compaction engine |

## Key Decisions

- **Thin bridge adapters** - OpenCode plugin and Codex bridge wrap the same Postgres-backed core rather than forking memory logic

- **No CLI** — plugin is runtime/API-first; TUI is optional adapter
- **PostgreSQL + pgvector** — vector search via DB, not in-process
- **Ollama** — local embedding generation, no external API
- **RRF hybrid search** — vector (0.35) + text (0.25) + entity (0.35) with exact-match boosting
- **Compaction quality gate** — entity_retention×0.35 + decision_retention×0.25 + error_retention×0.25 + similarity×0.15, reject if < 0.6
- **Lesson-recall integration** — `compileContextWithLessons()` recalls verified past lessons via `AlchemistEngine.recall()`, ranks by type priority + confidence (threshold ≥ 0.5), injects matching lessons into future task context, and exposes what was injected via `CompileResult.injectedLessons` + `lessonTelemetry`. Bulk-load lessons via `AlchemistEngine.store()`. Makes the agent less likely to repeat old mistakes.
- **Repo hygiene** — `npm run typecheck` (`tsc --noEmit`) and `npm run verify` (build + typecheck + full test suite) scripts. `*.bak` files gitignored. Core modules (`memory-graph`, `concept-extractor`, `priming-engine`) have dedicated test coverage.
- **Privacy/redaction layer (Phase 18)** — `src/redactor.ts` standalone module redacts secrets, emails, phones, IPs, URL creds, paths before ANY persistence (memory, embeddings, checkpoints, context cache, distilled summaries, Alchemist lessons). Paths normalized to `[WORKSPACE]/relative` by default. Configurable categories, audit counts only, fail-closed. Wired into `MemoryManager`, `CheckpointStore`, `context-cache-store`, distilled summaries, `AlchemistEngine`. 31 unit + 9 integration tests.

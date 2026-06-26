# System Map

> Auto-generated architecture reference. Updated on file edits via `auto-docs` hook.

## Core

| File | Exports | Type | Role |
|------|---------|------|------|
| `src/index.ts` | CrossSessionMemoryPlugin | plugin | Entry point — registers hooks, tools, DB |
| `src/plugin-context.ts` | PluginContext | context | Shared state container for all subsystems |
| `src/config.ts` | resolveConfig | config | Plugin config defaults + validation |
| `src/types.ts` | All interfaces & types | types | Shared type definitions |
| `src/tools.ts` | defaultTools | tools | Tool registration (CLI-facing) |
| `src/database.ts` | Database | database | PostgreSQL connection, schema init, migrations |
| `src/embeddings.ts` | EmbeddingGenerator | embeddings | Ollama embedding generation |
| `src/memory-manager.ts` | MemoryManager | memory | CRUD + search for memories |
| `src/memory-graph.ts` | MemoryGraph | graph | Concept extraction + link storage |
| `src/memory-extractor.ts` | MemoryExtractor | extractor | Raw text → semantic memory extraction |
| `src/concept-extractor.ts` | extractConcepts | concept | LLM-based concept extraction |
| `src/hybrid-search.ts` | hybridSearch, vectorSearch, fullTextSearch, entityMatchBoost | search | RRF-based hybrid search (vector + text + entity) |
| `src/compaction-quality.ts` | measureCompactionQuality, extractEntities, extractDecisions, extractWarningsErrors, computeRetention | metrics | Compaction quality scoring (entity/decision/error retention + drift) |

## Context Pipeline

| File | Exports | Type | Role |
|------|---------|------|------|
| `src/context-compiler.ts` | ContextCompiler | compiler | Builds context manifest from memories |
| `src/context-compactor.ts` | ContextCompactor | compactor | Distills tool-call output, runs quality measurement |
| `src/context-pressure.ts` | ContextPressure | pressure | Token budget tracking |
| `src/context-recall.ts` | ContextRecall | recall | Recall search tools |
| `src/context-rollover.ts` | ContextRollover | rollover | Session rollover with brief handoff |
| `src/context-rollover-config.ts` | RolloverConfig | config | Rollover configuration |
| `src/context-rollover-brief.ts` | generateRolloverBrief | brief | Generates next-session brief |
| `src/context-rollover-schema.ts` | rolloverSchema | schema | Rollover SQL schema |
| `src/context-compilation-log.ts` | CompilationLog | log | Compilation event logging |
| `src/context-compilation-schema.ts` | compilationSchema | schema | Compilation SQL schema |

## Context Cache

| File | Exports | Type | Role |
|------|---------|------|------|
| `src/context-cache-store.ts` | ContextCacheStore | store | Persist/restore cached context items |
| `src/context-cache-runtime.ts` | ContextCacheRuntime | runtime | Runtime read-through cache |
| `src/context-cache-manifest.ts` | ContextCacheManifest | manifest | Manifest builder for cached items |
| `src/context-cache-tools.ts` | ContextCacheTool | tools | Cache-aware tool registration |
| `src/context-cache-schema.ts` | cacheSchema | schema | Cache SQL schema |
| `src/context-review-tool.ts` | ContextReviewTool | review | Context review + compaction trigger |

## Checkpoint System

| File | Exports | Type | Role |
|------|---------|------|------|
| `src/checkpoint-builder.ts` | CheckpointBuilder | builder | Builds checkpoint from session state |
| `src/checkpoint-capture.ts` | captureCheckpoint | capture | Captures tool outputs for checkpoint |
| `src/checkpoint-inject.ts` | injectCheckpoint | inject | Restores checkpoint into context |
| `src/checkpoint-store.ts` | CheckpointStore | store | PostgreSQL checkpoint persistence |
| `src/checkpoint-schema.ts` | checkpointSchema | schema | Checkpoint SQL schema |
| `src/checkpoint-markdown.ts` | checkpointToMarkdown | markdown | Checkpoint → Markdown renderer |
| `src/checkpoint-telemetry.ts` | CheckpointTelemetry | telemetry | Checkpoint event tracking |
| `src/checkpoint-tool.ts` | CheckpointTool | tool | CLI checkpoint tool |
| `src/checkpoint-types.ts` | Checkpoint types | types | Checkpoint interface definitions |

## Compaction Helpers

| File | Exports | Type | Role |
|------|---------|------|------|
| `src/compaction-utils.ts` | compaction utils | utils | Shared compaction helper functions |
| `src/compaction-types.ts` | compaction types | types | Compaction-specific interfaces |
| `src/compaction-tracker.ts` | CompactionTracker | tracker | Cumulative compaction statistics |
| `src/helpers/compaction-metrics.ts` | compactionMetrics | metrics | Compaction telemetry helpers |
| `src/helpers/auto-checkpoint.ts` | autoCheckpoint | helper | Auto-checkpoint on risky edits |

## Hooks

| File | Exports | Type | Role |
|------|---------|------|------|
| `src/hooks/auto-docs.ts` | queueDocUpdate, flushDocUpdates, isIgnoredPath | hook | Queues doc updates on file edits, flushes on session end |
| `src/hooks/doc-analyzer.ts` | analyzeChange, applyDocUpdate, isIgnoredForAnalysis, isStubContent | analyzer | File change → doc section update (dedup, stub-filtered) |
| `src/hooks/tool-execute.ts` | afterToolExecute | hook | Post-tool execution: auto-docs, auto-checkpoint |
| `src/hooks/session-compaction.ts` | sessionCompactionHook | hook | Session-end compaction trigger |
| `src/hooks/system-transform.ts` | systemTransformHook | hook | System prompt injection |

## Other Subsystems

| File | Exports | Type | Role |
|------|---------|------|------|
| `src/goal-schema.ts` | goalSchema | schema | Goals SQL schema |
| `src/goal-tools.ts` | GoalTools | tools | Goal CRUD tools |
| `src/git-watcher.ts` | GitWatcher | watcher | Git change detection |
| `src/loop-detector.ts` | LoopDetector | detector | Repeated tool-call loop detection |
| `src/priming-engine.ts` | PrimingEngine | engine | Context priming on session start |
| `src/subconscious.ts` | Subconscious | subconscious | Background context maintenance |
| `src/token-bucket-analyzer.ts` | TokenBucketAnalyzer | analyzer | Token budget analysis |
| `src/tool-distiller.ts` | ToolDistiller | distiller | Distills tool-call output |
| `src/tui.ts` | TUI | tui | Solid-PRG TUI (optional adapter) |
| `src/assistant-text-compactor.ts` | AssistantTextCompactor | compactor | Compacts assistant response text |

## Key Decisions

- **No CLI** — plugin is runtime/API-first; TUI is optional adapter
- **PostgreSQL + pgvector** — vector search via DB, not in-process
- **Ollama** — local embedding generation, no external API
- **RRF hybrid search** — vector (0.35) + text (0.25) + entity (0.35) with exact-match boosting
- **Compaction quality gate** — entity_retention×0.35 + decision_retention×0.25 + error_retention×0.25 + similarity×0.15, reject if < 0.6

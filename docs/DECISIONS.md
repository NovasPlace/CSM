# DECISIONS.md

## Architecture Decisions

### 1. PostgreSQL over SQLite (External DB)
- **Decision**: Use PostgreSQL as primary memory store
- **Why**: Survives OpenCode reinstalls; built-in SQLite at `~/.config/opencode/` gets wiped
- **Trade-off**: Requires running PostgreSQL instance (Docker/local)
- **Status**: ✅ Implemented — confirmed survival across reinstall (Jun 25)

### 2. Adapter Boundaries (Database Class)
- **Decision**: Encapsulate all SQL in `Database` class (`src/database.ts`)
- **Why**: Single migration point; swap backend if needed; testable
- **Trade-off**: Slight abstraction overhead
- **Status**: ✅ Implemented

### 3. Semantic Search via pgvector
- **Decision**: Store embeddings in `memories.embedding` (VECTOR(1536))
- **Why**: Enables `memory_search` with semantic similarity, not just keywords
- **Trade-off**: Requires pgvector extension; embedding generation cost
- **Status**: ✅ Schema ready; embedding generation in extractor

### 4. Memory Types as Fixed Enum
- **Decision**: `conversation | workspace | repo | preference | lesson | episodic | procedural | concept | code | config | error`
- **Why**: Predictable filtering; lessons get higher default importance (0.75)
- **Trade-off**: Less flexible than free-form tags
- **Status**: ✅ Enforced in `types.ts` and DB CHECK constraint (with ALTER migration)

### 5. Background Subconscious Processing
- **Decision**: `Subconscious` class runs distillation periodically, not on every turn
- **Why**: Avoids blocking user-facing operations; batches work
- **Trade-off**: Memories not instantly distilled
- **Status**: ✅ Implemented with configurable interval

### 6. Tool Distillation Separate from Memory Extraction
- **Decision**: `ToolDistiller` → structured summaries → `MemoryExtractor` → memories
- **Why**: Separation of concerns; distiller knows tools, extractor knows memory schema
- **Trade-off**: Two passes over tool output
- **Status**: ✅ Implemented

### 7. Context Compaction for Token Budget
- **Decision**: `ContextCompactor` compresses tool outputs before context injection
- **Why**: Prevents context window overflow in long sessions
- **Trade-off**: Loss of detail in compressed summaries
- **Status**: ✅ Implemented with risk labels (low/medium/high)

### 8. Priming at Session Start Only
- **Decision**: `PrimingEngine.prime()` runs once at session initialization
- **Why**: Avoids mid-session context shifts; predictable behavior
- **Trade-off**: New memories not available until next session
- **Status**: ✅ Implemented

### 9. Disabled Features by Default
- **Decision**: `autoDistill: false`, `semanticSearch: false` in default config
- **Why**: Opt-in for resource-intensive features; stable defaults
- **Trade-off**: Users must enable explicitly
- **Status**: ✅ In `config.ts:DEFAULT_CONFIG`

### 10. No CLI (Phase 1–11)
- **Decision**: No CLI; plugin is runtime/API-first; TUI is optional adapter
- **Why**: Plugin integrates via hooks, tools, and API; CLI adds packaging complexity
- **Trade-off**: No standalone CLI usage
- **Status**: ✅ Stable — TUI adapter optional, graceful failure if unavailable

### 11. Auto-Documentation via Tool Hooks (Phase 2)
- **Decision**: Hook into `tool.execute.after` to queue doc updates; flush at session end via `dispose`
- **Why**: Eliminates manual discipline; docs stay in sync automatically
- **Trade-off**: Slight overhead on file ops; potential for stale docs if flush fails
- **Status**: ✅ Implemented — `src/hooks/auto-docs.ts`, integrated in `tool-execute.ts` + `index.ts`

### 12. Auto-Docs Noise Guard (Phase 3)
- **Decision**: Filter auto-doc updates with: ignored paths, deduplicate, group edits, cap entries, config toggle
- **Why**: Prevents recursive loops, changelog spam, meaningless entries
- **Trade-off**: Some minor edits won't appear individually
- **Status**: ✅ Implemented

### 13. Project Isolation for Memory Hygiene (Phase 5)
- **Decision**: Add nullable `project_id` to `memories` and `session_contexts`
- **Why**: Prevents cross-project memory pollution
- **Trade-off**: Migration complexity; nullable column for backward compatibility
- **Status**: ✅ Schema migration + query paths updated

### 14. Tool Call Context Firewall (Phase 5)
- **Decision**: Rewrite `ContextCompactor` with budget cap, expandable refs, telemetry
- **Why**: Tool calls were ~80% of context; raw output is evidence not conversation
- **Trade-off**: More complex compaction logic
- **Status**: ✅ Implemented

### 15. Automatic Concept Extraction + Memory Graph (Phase 8)
- **Decision**: `extractConcepts()` via LLM generates concept nodes; `MemoryGraph` stores bidirectional links between concepts and memories
- **Why**: Enables concept-based recall (not just keyword/semantic); builds knowledge graph over time
- **Trade-off**: LLM call per extraction; graph adds DB complexity
- **Status**: ✅ Implemented — `src/concept-extractor.ts`, `src/memory-graph.ts`, `memory_list` enhanced with concept filtering

### 16. Hybrid Search: Vector + Text + Entity RRF (Phase 9)
- **Decision**: `hybridSearch()` combines vector similarity, full-text search, and entity-match boosting via Reciprocal Rank Fusion
- **Why**: Pure vector search misses exact code matches (function names, file paths, error names); pure text misses semantic links
- **Trade-off**: Three queries per search; more complex scoring
- **Status**: ✅ Implemented + benchmarked — 5/5 queries won vs vector-only (exact code: ~47x score advantage, semantic: no regression)
- **Weights**: `vector=0.35, text=0.25, entity=0.35, recency=0.05`
- **Bug fix**: `$2` parameter conflict between `LIMIT` and JSONB entity match; `metadata.extracted_concepts` missing from WHERE clause

### 17. Compaction Quality Metrics Gate (Phase 11)
- **Decision**: `CompactionQualityMetrics` measures: compression_ratio, entity_retention, decision_retention, warning_error_retention, embedding_drift, quality_score; reject if quality_score < 0.6
- **Why**: "Reduces tokens without damaging continuity" must be provable, not assumed
- **Trade-off**: Adds overhead to compaction; threshold may need tuning per project
- **Status**: ✅ Implemented — `src/compaction-quality.ts`, 34 tests passing
- **Formula**: `quality_score = entity_retention×0.35 + decision_retention×0.25 + error_retention×0.25 + similarity×0.15`

### 18. Doc-Analyzer Dedup + Stub Filtering (Phase 11+)
- **Decision**: `doc-analyzer.ts` must check: (1) entry doesn't already exist for same file, (2) file has real exports/imports (not a stub), (3) file exists on disk
- **Why**: Previous version produced 530-line SYSTEM_MAP.md full of `src/a.ts`, `src/new-feature.ts` stubs
- **Trade-off**: Doc updates are slower (disk reads); some legitimate stubs won't appear
- **Status**: ✅ Implemented — `isStubContent()`, `isIgnoredForAnalysis()`, dedup in `applyDocUpdate()`

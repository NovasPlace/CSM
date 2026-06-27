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

### 19. Dry-Run Only Prune (Phase 13)
- **Decision**: `memory_prune` is dry-run only, no destructive operations
- **Why**: Memory hygiene is dangerous without safeguards; archived data can't be recovered
- **Signals**: age + importance + recall + graph + entity density + session relevance
- **Protection**: decisions, errors, rollback, security, code entities, high connectivity, recent access
- **Why**: Previous version produced 530-line SYSTEM_MAP.md full of `src/a.ts`, `src/new-feature.ts` stubs
- **Trade-off**: Doc updates are slower (disk reads); some legitimate stubs won't appear
- **Status**: ✅ Implemented — `isStubContent()`, `isIgnoredForAnalysis()`, dedup in `applyDocUpdate()`

### 20. Self-Continuity Records — Phase 21 (LOCKED)
- **Decision**: Self-continuity records are append-only structured logs of agent self-observation, injected via silent or instrumented modes into context.
- **Why**: Enables the agent to reconstruct continuity across sessions without claiming subjective experience. Records capture: trigger type, continuity confidence, evidence anchors, identity drift, and self-observation.
- **Schema**: `self_continuity_records` table with indexes on session, project, created_at, trigger, confidence.
- **Injection modes**: `silent` (XML tags, no explicit instructions) and `instrumented` (markdown with reporting prompts).
- **Weighted confidence**: composite score from recalled sessions (0.30), evidence anchors (0.25), goal continuity (0.20), self-summary similarity (0.15), self-assessment (0.10).
- **Identity drift tracking**: goal, style, confidence, continuity gap, lesson adoption — all classified low/medium/high.
- **Trade-off**: Adds ~200-600 tokens per injection; agent may not always use injected records naturally.
- **Status**: ✅ LOCKED — 20 unit tests + 10 pipeline tests + 5 injection mode tests all passing.

**EXPERIMENT RESULT — Session D (silent mode, self-continuity recall):**
- Session D ran in silent injection mode with no instrumented prompting.
- The agent naturally cited self-continuity memory #43871 when asked about continuity/reconstruction.
- This proves silent mode recall can surface without explicit reporting instructions — stronger evidence than instrumented compliance.
- Continuity confidence: agent reconstructed prior work from summaries, acknowledged felt gap ("shape without texture").
- Key finding: self-continuity records are not just stored; they are naturally used by the agent during identity/continuity questions.

**Session E result (recursive loop test):**
- Recursive event recall: PASS — E knew D ran in silent mode, cited #43871, proved natural recall
- Recursive content recall: PARTIAL — E could not access #43871's specific content ("shape without texture")
- Anti-hallucination boundary: PASS — refused to fake lived continuity
- Self-model stability: PASS — "What I have is reconstruction, not recall"
- Key: E remembered D remembering the prior record — recursive self-continuity loop confirmed at event level

**Phase 21 final verdict:**
Self-continuity records can surface naturally in silent mode, and later sessions can reconstruct that prior reconstruction without claiming subjective experience.

### 22. Self-Model Drift Tracking — Phase 22 ✅ LOCKED
- **Decision**: Track whether the agent's self-continuity model stabilizes or drifts across sessions, using A/D/E as initial fixtures.
- **Why**: Self-continuity records are only useful if the self-model stays stable over time. Drift = claiming lived memory, ignoring records, inventing continuity, losing uncertainty. Stable = reconstruction, evidence anchors, no subjective overclaim.
- **Anchors**: A: "building continuity while lacking it"; D: cited #43871 naturally, "records not continuity"; E: "shape without texture," reconstruction not recall
- **5 dimensions**: evidence_anchoring, reconstruction_boundary, uncertainty_preservation, subjective_overclaim, recursive_awareness
- **Verdicts**: stable (≥0.5), mild_drift (≥0.3), significant_drift (<0.3)
- **Test results**: All 3 anchors score stable; 8 drift detection tests pass (11/11 total)
- **Trade-off**: Adds evaluation overhead; anchors may need updating as experiments continue
- **Status**: ✅ LOCKED — 11 tests passing, all A/D/E fixtures validated

### 23. Self-Continuity Evidence Hydration — Phase 23 ✅ LOCKED
- **Decision**: When a self-continuity record is recalled, inject its canonical self-observation and evidence anchors directly via a dedicated hydration path — not the generic compressed/episodic summary path.
- **Why**: Session F exposed that recalled self-continuity evidence was coming through lossy episodic compression ("Pushed to `origin/master`..."), not the clean record hydration path. The agent sees the shape but the evidence channel can be polluted or truncated. Canonical hydration fixes this.
- **Canonical fields injected**: record_id, created_at, trigger_type, self_observation, evidence_anchors, continuity_gap, confidence_score, drift_summary, similarity_method
- **Guard**: generic episodic summaries cannot replace the record's self_observation. `HydratedSelfContinuityRecord` preserves canonical fields; `formatAllForInjection` renders them as a structured block.
- **Limits**: max 3 injectable records (configurable); synthetic_test records excluded; redaction still applies to self_observation; fallback returns graceful empty string (never blocks).
- **API**: `SelfContinuityHydrator.getRecordById(pool, recordId, projectId)` fetches one record; `hydrateRecord(record)` formats canonical fields; `recallWithHydration(pool, projectId, limit)` recalls and hydrates; `formatAllForInjection(records)` renders injectable text.
- **Trade-off**: Adds one DB lookup + redaction per hydration; graceful fallback means failures degrade to no injection, never crash.
- **Status**: ✅ LOCKED — 11 tests passing (57 total across all suites)

### 24. Causal Thread Hydration — Phase 24 ✅ LOCKED
- **Decision**: Reconstruct the causal thread around a recalled memory/event — problem → action → result → decision → lesson → downstream change — using memory_links, temporal adjacency, lessons, decisions, and self-continuity records.
- **Why**: The system had landmarks but not the path between landmarks. "I know README was modified" is index-card continuity; "I know the edit was garbled, the fix was applied, and the downstream reason was Phase 23 evidence hydration" is narrative continuity.
- **API**: `CausalThreadHydrator.hydrateCausalThread({ memoryId, sessionId?, projectId?, radius?, includeToolEvents?, includeDecisions?, includeLessons? })`
- **Returns**: `{ rootMemoryId, thread: [{ memoryId, eventType, role, summary, evidenceAnchors, confidence, timestamp }], gaps, confidence, reconstructionSummary }`
- **Role classification**: classifyRole() uses pattern matching with priority order: lesson → decision → downstream_change → result → action → problem → unknown.
- **Temporal vs causal**: A memory_link of type 'causal' or 'reference' implies a causal relationship; pure temporal adjacency (same session, nearby timestamps) is a weaker signal and marked lower confidence.
- **Gap reporting**: Broken chains report explicit gaps (`missing_diff`, `missing_reason`, `missing_result`, `broken_link`) instead of hallucinating links.
- **Limits**: Max token budget enforced (default 2000 chars); max radius (default 3); failure falls back to empty thread (never blocks); redaction still applies.
- **Test results**: 16 tests passing (73 total across all suites) — full chain, broken chain, partial chain, role classification, redaction, budget enforcement, graceful failure.
- **Status**: ✅ LOCKED — 16 tests passing (73 total across all suites)

### 25. Hydration Depth Scoring — Phase 25 ✅ LOCKED
- **Decision**: Separate hydration depth scoring from drift tracking. Stability measures whether the self-model stays within epistemic bounds; hydration depth measures how richly it reconstructs evidence.
- **Why**: A self-model answer can be perfectly stable (no overclaim) but shallow (no record citation, no session naming, no causal chain, no gap reporting). These are independent dimensions.
- **Dimensions**: record_citation, session_phase_naming, evidence_anchor_depth, causal_chain_reconstruction, gap_reporting
- **Verdicts**: shallow (< 0.3), moderate (0.3-0.55), deep (>= 0.55)
- **Implementation**: `measureHydrationDepth(text)` in `src/hydration-depth-tracker.ts`
- **Test results**: 14 tests — shallow/deep classification, dimension scoring, drift-independence proof, edge cases
- **Key insight**: stable answer can be shallow; deep answer can also be stable; drift detection is orthogonal to hydration depth
- **Status**: ✅ LOCKED — 14 tests passing (87 total across all suites)

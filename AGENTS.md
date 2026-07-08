## Goal
- SQLite MVP complete (Phase 3). Lint debt reduction in progress: Phase L1+L2, L3.1, L3.2, L3.3, L3.4, L3.5 done. Baseline locked at **102 warnings**.
- Phase 4 (Living State Layer) complete: experience packets, self-model, belief knowledge, advisory context-brief injection. All 4F-C requirements verified.

## Constraints & Preferences
- Each sub-phase is behavior-preserving, boring, verbatim moves first
- CSM_EMBEDDING_PROVIDER (ollama|openai), OPENAI_API_KEY, OLLAMA_HOST
- Database URL: dev/test=localhost, production=explicit flag
- CI with Postgres service container
- ESLint rules start as warnings, tighten later
- Lint warning baseline: **102 warnings** (max-warnings=102 prevents unbounded growth)
- `caughtErrorsIgnorePattern: '^_'` added to `@typescript-eslint/no-unused-vars` — catch blocks with `_err` are allowed
- `better-sqlite3` doesn't support `?NNN` format with spread `.run()` — must use anonymous `?` parameters
- SQLite schema: TEXT for timestamps/JSON/arrays/embeddings; INTEGER PRIMARY KEY AUTOINCREMENT for PKs
- PostgreSQL remains default; SQLite is adapter path, not rewrite; no vector search in SQLite MVP
- `memories.session_id` is nullable (FK on sessions, NULL bypasses it)

## Lint Debt Classification (Locked)
- **0 `no-console` warnings**: All 15 intentional console calls documented with `eslint-disable-next-line no-console` rationale
- **~7 `no-explicit-any` warnings**: Remaining `any` in memory-extractor.ts (false positive - `determineInitialStatus` returns specific union type but linter can't infer this in this context)
- **7 `no-unused-vars` warnings**: External API generic params (`opentui.d.ts`) — skipped by design
- **`max-warnings=7`** — any new warning added to src/ will fail lint

## Progress
### Done
- **Phase 7A — Re-entry Context Builder**: `src/re-entry-protocol.ts` orchestrates 8 layers with priority-based trimming, builds contextual block, preview-only mode.
- **Phase 7B — Session Start Integration**: `src/hooks/system-transform.ts` injects re-entry block on first turn (preview-only default, first-turn tracking via `reentryInjected` Set). 4 new tests (all pass).
- **Phase 7C — Re-entry Protocol Documentation**: `docs/PHASE7C_REENTRY_PROTOCOL_DOCUMENTATION.md` created with purpose, injection mode, layer order, trimming behavior, safety model, diagnostics, validation checklist.
- **Phase 7 Complete**: Full test suite passes (808/808), typecheck clean, build clean, lint 7 warnings, live preview-only restart confirms no behavior change. Committed `aa352f2`.

### In Progress
- **Phase 8A-R — Re-entry UX Interface Repair**: `docs/PHASE8A_REPAIR.md` created documenting actual ReEntryProtocol interface, adapter plan, and tool registry consistency fix. All 808 tests pass. Next: implement adapter + tool. Committed `b77dd6e`.

### Done
- **Phase 8A-Impl — Re-entry Preview Adapter + Tool**: `src/reentry-ux-tool.ts` — `ReEntryPreviewAdapter` wrapping real `ReEntryProtocol` (built against actual `ReEntryDiagnostic` interface, not an imagined one). `csm_reentry_preview` tool registered in `src/hooks/tool-hooks.ts`; `ReEntryPreviewAdapter` instantiated from `pluginCtx.reEntryProtocol`. Read-only: calls `buildBlock()`/`diagnose()` only, no writes. 5 new tests. Tool count 31→32. Committed `4b7c2f1`.

### Done
- **Phase 1A (Config Contract)**: `.env.example` (19 env vars), `src/config.ts` with `getEnvString/getEnvBoolean/getEnvNumber`, provider-specific env vars, mode-based DB URL, `validateAndReturnConfig()`
- **Phase 1B (Logger Foundation)**: `src/logger.ts` with levels (debug/info/warn/error) and context (session/project/turn/memoryId), `src/stats-writer.ts` updated, `src/index.ts` startup/dispose paths use logger
- **Phase 1C (Index Split)**: `src/hooks-registration.ts` (466 lines) with verbatim hooks/tools/dispose; `src/index.ts` simplified to re-exports; `src/plugin-entry.ts` removed
- **Phase 1D (CI)**: `.github/workflows/ci.yml` with PostgreSQL 14 Alpine service, typecheck/build/test steps, CSM_DATABASE_URL env var
- **Phase 1E (Mechanical Cleanup)**: Migrated 86 console calls to logger across 24 files
- **Phase 1E.1 (Lint Baseline Fix)**: Separated `lint`/`lint:src`/`lint:all`/`lint:fix` scripts. Test files excluded from lint:src. All 286 errors fixed → 0 errors.
- **Phase 1F (Hook File Split — Stabilization)**: Restored 9 deleted hook files from git. Fixed import paths, `fromSessionId` scope, redactor.ts escapes, empty blocks, `prefer-const`.
- **Phase 1G (Final Hook Registration Split)**: `hooks-registration.ts` 423→134 LOC. Created `hooks/event-hooks.ts` (125 LOC), `hooks/tool-hooks.ts` (49 LOC), `hooks/dispose-hooks.ts` (82 LOC). Plain `sessionState` object. Warnings 271→251.
- **Phase 2B (Embedding Backfill)**: `src/embedding-backfill.ts` — batch/offset/resume/rate-limited. Tool `csm_memory_backfill_embeddings`. Tests: 6/6 pass.
- **Phase 2A.1 (Dedup Detection)**: `src/dedup-detector.ts` — exact content/title + embedding ANN. Tool `csm_memory_dedup_detect` (read-only). Tests: 8/8 pass.
- **Phase 2A.2 (Safe Merge)**: `src/merge-tool.ts` — exact normalized content duplicates only. Schema: `memory_merges` table, `superseded_by`/`superseded_at`. Tool `csm_memory_merge`. Tests: 7/7 pass.
- **Lint Baseline Lock**: `max-warnings=140`. Added `caughtErrorsIgnorePattern: '^_'` to ESLint config (dropped 2 catch-var warnings). Documented `any` warnings as typed-debt, `console` warnings as intentional. Confirmed: blanket `any`→`unknown` causes 55+ build errors — do not attempt.
- **Phase 2C (Governance/Archive)**: Archive system (7,379 memories archived: 7,241 superseded + 138 tiny-junk). Governance status reports with invariant checks. Archive-aware candidate reports.
- **Phase 3A (SQLite Design)**: `docs/PHASE3A_SQLITE_DESIGN.md` — 57 files, 24 tables catalogued. Phased plan.
- **Phase 3B (Adapter Interface)**: `src/db/database-pool.ts` factory, `src/db/postgres-pool.ts` wrapper, `src/db/sqlite-pool.ts` adapter ($N→? translation, ::cast stripping, RETURNING detection). `DatabaseProvider` type. 11 new tests (9 sqlite + 2 postgres).
- **Phase 3C (Schema Bootstrap)**: `src/schema/sqlite/index.ts` — 7 tables (sessions, memories, memory_chunks, memory_merges, memory_quality_scores, memory_events, memory_recall_events). `src/schema/index.ts` early-return for sqlite. 3 smoke tests.
- **Phase 3D (Query Compatibility)**: `src/db/query-dialect.ts` — `QueryDialect` type + 11 helpers (nowFn, ilikeExpr, jsonKeyExists, jsonExtractText, jsonArrayContains, jsonContainsPath, isUniqueViolation, jsonParam, toDate, parseArrayField, parseJsonField). `Database.dialect` getter. Narrow-path methods in MemoryManager patched: createSession, saveMemory, listMemories, textSearchFallback, searchMemories (sqlite→text fallback), touchMemory, storeEmbedding, mapSession, mapMemory, getEventsSince, etc. Vector search degraded to text search on SQLite.
- **Phase 3E (CRUD Contract Tests)**: `test/backend-contract.test.ts` — shared backend contract tests for createSession, saveMemory, listMemories, getSession, touchMemory, metadata round-trip. Run against both PG and SQLite. All 12 CRUD tests pass.
- **Phase 3F (SQLite Search Contract)**: Search contract tests (8 tests) added to `test/backend-contract.test.ts` — prefix match, non-matching query, type filter, tag filter, degradation safety, listMemories tag filter, projectId scope. 26 total contract tests (13 PG + 13 SQLite) all pass.
- **Phase 3F.1 (SQLite Search Indexes)**: Added `idx_memories_project`, `idx_memories_type`, `idx_memories_importance_created` to SQLite schema for search query performance.
- **Phase 3F.2 (Embedding Generation Optimization)**: Moved `embeddings.generate()` call after the SQLite dialect check in `searchMemories`, eliminating wasted API calls on SQLite.
- **Phase 3F.3 (Hybrid Search Filter Fix)**: Fixed `hybridSearch` to propagate `type`, `tags`, and `minImportance` filters to all sub-searchers (`vectorSearch`, `ftsSearch`, `entityMatchBoost`). Added `buildWhereClause` helper for dynamic SQL filter construction. This fixes a long-standing bug where type/tag filters were silently ignored on PG.
- **Phase 3G (SQLite MVP Documentation)**: `docs/PHASE3G_SQLITE_MVP.md` — covers how to enable SQLite, supported/degraded/unsupported features, verification results, known gaps, and architecture notes.
- **Phase 3H (Fix Backfill Recall Telemetry Test Debt)**: Root cause: `pg` returns `COUNT(*)` (bigint) as string, so `typeof r.recall_count === 'number'` was false → `recallCount` defaulted to 0 → prune-scorer never saw recall data. Fixed by using `Number()` cast instead of `typeof` check for both `recall_count` and `graph_links` in `loadPruneRows`. Full suite now 622/622 green.
- **Phase 3I (SQLite MVP Release Notes)**: README updated with SQLite quickstart, config table, 8 known limitations. CHANGELOG updated with Phase 1-3 highlights. Key decision: PG default, SQLite alternative. Committed `686a2c3`.
- **Phase 3 Complete**: All 9 sub-phases (3A-3I). 10 CSM memories, 14 work journal entries logged.
- **Phase L4-A through L4-K (Lint Cleanup 102→7)**: Replaced 34 `any` with specific types (`Record<string, unknown>`, `unknown`, interfaces). Fixed 11 files: hooks/event-hooks.ts, hooks/tool-hooks.ts, hooks/tool-execute-memory.ts, hooks-registration.ts, lesson-trigger-cache.ts, memory-extractor.ts, memory-manager.ts, memory_governance.ts, token-bucket-analyzer.ts. Warnings: 102→7 (all in opentui.d.ts external API types, skipped by design). `max-warnings` ratcheted to 7. Committed multiple times.
- **Phase L1+L2 (Lint Cleanup 249→154)**: no-console 15→0 (7 migrated, 8 eslint-disable+rationale). no-unused-vars 86→7 (73 fixed: unused imports removed, unused args prefixed). 37 files changed. `max-warnings` ratcheted to 154. Committed `d90570f`.
- **Phase L3.1 (Type Tool Execute Hook Payloads)**: Defined 5 DTOs (`ToolExecuteBeforeInput`, `ToolExecuteBeforeOutput`, `ToolExecuteAfterInput`, `ToolExecuteAfterOutput`, `ToolExecuteMetadata`). Replaced all 14 `any` in `src/hooks/tool-execute.ts` → 0. Fixed 6 logger context type errors. Warnings: 154→140. `max-warnings` locked at 140. Committed `4fae542`.
- **Phase L3.2 (Type Checkpoint Tool Rows)**: Replaced 8 `any` in `src/checkpoint-tool.ts` → 0. Defined `SdkMessage` + `SessionMessagesClient` interfaces. Changed `toSessionMessages` param from `SessionMessage[]` to `SdkMessage[]`. Added `SessionPart` import. Warnings: 140→132. `max-warnings` ratcheted to 132.
- **Phase L3.3 (Type Memory Graph Row DTOs)**: Defined `CandidateRow`, `SourceRow`, `LinkRow`, `RelatedRow` row-mapper DTOs. Replaced 8 `as any[]` casts → typed and `any` in some callback → typed. Warnings: 132→124. `max-warnings` ratcheted to 124.
- **Phase L3.4 (Type Tools Payloads)**: Replaced 4 `any` in `src/tools.ts` with `MemoryType` and typed metadata access. Warnings: 124→120. `max-warnings` ratcheted to 120.
- **Phase L3.5 (Type Context Compiler Rows)**: Replaced 18 `any` in `src/context-compiler.ts` with `SdkPart`/`SdkMessage` interfaces. Warnings: 120→102. `max-warnings` ratcheted to 102.
- **Phase 4A (Experience Packets)**: `src/experience-packet.ts` — ExperiencePacketCreator with 8 entry types (tool_execution, error, milestone, decision, session_start, session_end, loop_signal, general). Schema: `experience_packets` table. `src/internal-state-deriver.ts` — 10 pure functions for frustration/energy/stance/urgency derivation. Wired into tool-execute after-hook. 22 tests pass.
- **Phase 4B.5 (Packet Contract Lock)**: `docs/PHASE4B5_PACKET_CONTRACT.md` — three-layer separation doc. Vocabulary locked. `csm_memory_packets` tool enriched with filters. 2 contract tests. PG ↔ SQLite vocabulary matched.
- **Phase 4C-A (Belief Promotion Scanner)**: `src/belief-promotion-scanner.ts` — reads packets, groups by pattern fingerprints, maps to 5 candidate types, confidence formula, contradiction penalty. `src/belief-scan-tool.ts` — csm_belief_scan, csm_belief_scan_report tools. 15 tests pass.
- **Phase 4C-B (Unified Candidate Queue)**: `src/candidate-schema.ts` — unified queue with 10 candidate types (5 maintenance + 5 belief). ALTER TABLE ADD COLUMN IF NOT EXISTS for dedup_key, event_count, reinforcement_count, contradicted_count, source_packet_ids, promotion_ready. Partial unique index on (candidate_type, dedup_key) WHERE dedup_key IS NOT NULL AND status = 'pending'. MEMORY_ID nullable.
- **Phase 4D-A (Self-Model Foundation)**: `src/self-model-schema.ts` — self_model_capabilities table. `src/self-model-updater.ts` — SelfModelUpdater class with per-capability evidence refs. `src/self-model-tool.ts` — csm_self_model read-only tool. 12 tests pass.
- **Phase 4E-A (Belief Knowledge Foundation)**: `src/belief-knowledge-schema.ts` — belief_knowledge_store (PG + SQLite). `src/belief-knowledge-store.ts` — BeliefKnowledgeConsolidator module. `src/belief-knowledge-tool.ts` — csm_belief_knowledge read-only tool. Wired into PluginContext/hooks-registration/tool-hooks.
- **Phase 4E-B (Belief Knowledge Contract)**: `test/belief-knowledge-store.test.ts` — 14 tests (10 consolidator + 4 tool). `docs/PHASE4EB_BELIEF_KNOWLEDGE_CONTRACT.md`.
- **Phase 4F-A (Runtime Loop Preview)**: `src/living-state-runtime.ts` — LivingStateRuntime orchestrator. `src/living-state-tool.ts` — csm_living_state_preview tool. 11 acceptance tests. `docs/PHASE4FA_LIVING_STATE_PREVIEW.md`.
- **Phase 4F-B (Advisory Context Brief Block)**: `src/living-state-advisor.ts` — LivingStateAdvisor module with assembleBlock(), diagnose(), buildBlockLines(), dropSection(), trimToBudget(). Wired into system-transform.ts after context brief. injectAdvisoryBlock=false default. maxAdvisoryBlockChars=1000. Untrusted trace labeling. 17 tests pass. Budget trimming: beliefs→capabilities→signals dropped first.
- **Phase 4F-C (Staged Enablement)**: LivingStateDiagnostic interface, diagnose() method, csm_living_state_debug diagnostic tool. 6 acceptance tests. `docs/PHASE4FC_STAGED_ENABLEMENT.md`. Production schema bug fix: DROP INDEX IF EXISTS before CREATE UNIQUE INDEX IF NOT EXISTS (PG does not upgrade non-unique indexes). CSM lesson #55513.
- **Phase 4F-C Live Smoke Test**: All 4 tools verified against live PG. Advisory block injection verified: "preview, not durable truth", no imperative language, evidence refs, prompt ordering context brief → advisory → task context. 722/722 tests pass, lint 102, build clean. Committed `b06e90d`.

### Blocked
- **`no-explicit-any` cleanup (~102 warnings)**: Typed-debt remains in checkpoint-store.ts (row mapper), agent-work-journal.ts, context-cache-runtime.ts, and other modules. Requires per-module typed DTOs and generic row mappers, not blanket replacement.
- **`no-console` cleanup (~8 warnings)**: Remaining `eslint-disable-next-line no-console` annotations in auto-docs.ts, system-transform.ts, work-journal-inject.ts. Blocked by need for logger context support or structural refactors.

### Pre-existing Test Debt
- ~~**1 failing test**: `test/backfill-recall-telemetry.test.ts` line 209 — "protects old recalled memories while still surfacing old unrecalled ones" fails because prune-protection by recall count is not working for PG. Present since Phase 3B (`ae5e309`). Not caused by Phase 3D changes. Root cause: `pruneMemories`/`loadPruneRows` recall_count LATERAL join returns 0 even when `memory_recall_events` rows exist. Needs investigation in prune-scorer logic.~~
- **Resolved in Phase 3H**: Root cause was `pg` returning `COUNT(*)` as string (bigint). `typeof r.recall_count === 'number'` was always false, so recallCount defaulted to 0. Fixed by using `Number()` cast instead of `typeof` check.

## Key Decisions
- Plain `sessionState` object (not getter-based wrappers) for mutable state shared across hook modules
- Embedding similarity not useful for dedup at current scale — exact content detection catches all real duplication
- Merge is exact-match-only — no embedding-based merging; no deletion; mark superseded; preserve originals
- `any`→`unknown` substitution is NOT safe at scale — requires per-file analysis and typed DTOs/generic mappers
- Lint baseline locked at 140 — new warnings fail CI; existing debt is classified and documented
- `caughtErrorsIgnorePattern: '^_'` allows `catch (_err)` without warning
- SQLite RETURNING and ON CONFLICT DO UPDATE work (SQLite 3.24+/3.35+ bundled with better-sqlite3)
- SQLite JSON ops: `json_type(col, '$.key')` replaces `col ? 'key'`; `json_extract(col, '$.key')` replaces `col->>'key'`; `json_each(col)` replaces `col && $N`
- SQLite empty-result security: `LOWER(col) LIKE LOWER($N)` replaces `col ILIKE $N`
- SQLite vector search: degraded to text search (no `<=>`/pgvector equivalent)
- PostgreSQL `CREATE UNIQUE INDEX IF NOT EXISTS` does not upgrade existing non-unique indexes — must DROP INDEX IF EXISTS first (CSM #55513)

## Next Steps
1. Phase L4+: continue typed-DTO pass on `checkpoint-store.ts`, `agent-work-journal.ts`, `context-cache-runtime.ts`
2. Fix remaining `no-console` warnings (auto-docs.ts x3, system-transform.ts x3, work-journal-inject.ts x1) — convert to logger
3. Remaining L3 cleanup is done — consider L4 planning
4. Phase 4G+: belief promotion pipeline (auto-promote high-confidence candidates to memories)

## Critical Context
- Windows/PowerShell environment: `grep`→`rg`, `wc`→manual count, `&&`/`||`→PowerShell syntax
- All checks green: typecheck, build, lint:src (0 errors, 102 warnings)
- Full test suite: **722/722 pass**
- `git restore src/` + `git restore eslint.config.mjs` restores clean working tree
- Live DB: 46,680 total memories; 38,000+ active; 7,500+ with embeddings
- Schema additions: `memory_merges` table, `memories.superseded_by`/`superseded_at`, `memory_recall_events`
- SQLite schema: 7 tables, all indexed — `src/schema/sqlite/index.ts`
- `src/checkpoint-store.ts`: `rowToCheckpoint()` uses `row: any` — needs typed DTO (Phase L4 target)
- `src/memory-graph.ts`: ~8 `any` usages — next cleanup target (Phase L3.3)
- `src/context-compiler.ts`: 19 `any` usages — highest-risk file (Phase L3.5)
- `src/context-compiler.ts`: 19 `any` usages — highest-risk file (Phase L3.5)

## Relevant Files
- `src/db/query-dialect.ts`: `QueryDialect` type + 11 dialect helpers — Phase 3D
- `src/db/database-pool.ts`: `DatabaseProvider` type, `createDatabasePool()` factory — Phase 3B
- `src/db/postgres-pool.ts`: wraps `pg.Pool` → `DatabasePool`
- `src/db/sqlite-pool.ts`: `better-sqlite3` adapter, param translation, cast stripping
- `src/schema/sqlite/index.ts`: 7-table SQLite DDL — Phase 3C
- `src/schema/index.ts`: dispatches to sqlite/postgres schema init based on provider
- `src/database.ts`: `Database` class with `dialect` getter, factory dispatch, `getProvider()` method
- `src/memory-manager.ts`: narrow-path methods dialect-aware — Phase 3D
- `src/hybrid-search.ts`: hybrid search with `buildWhereClause` filter helper, dialect-aware sub-searchers — Phase 3F.3
- `src/types.ts`: `DatabaseProvider`, `DatabasePool`, `DatabaseClient`, `PluginConfig`
- `src/config.ts`: `CSM_DATABASE_PROVIDER`, `CSM_SQLITE_PATH` parsing
- `eslint.config.mjs`: ESLint v9 flat config, `caughtErrorsIgnorePattern: '^_'`, src strict, tests relaxed
- `package.json`: `max-warnings=102` on `lint:src`

## Remaining Test Lint Debt
- 774+ errors, 261+ warnings across test files (`**/*.{test,spec}.ts`)
- Excluded from `lint:src` with `no-console: off`, `no-explicit-any: off`, `no-unused-vars: off`

## Phase 1G Completion Status
- ✅ hooks-registration.ts split: 423 LOC → 134 LOC (under 200)
- ✅ hooks/event-hooks.ts: 125 LOC, hooks/tool-hooks.ts: 49 LOC, hooks/dispose-hooks.ts: 82 LOC
- ✅ Replaced getter-based state with plain sessionState object
- ✅ Removed ~20 unused imports (warnings 271 → 251)

## Current Lint Status
- `npm run lint:src`: 0 errors, **7 warnings** (all in opentui.d.ts, skipped by design) → exits 0
- `npm run lint:all`: ~774 errors + ~261 warnings across test files (excluded from lint:src)

## Phase 2X: Type Debt Reduction (Future)
- Goal: reduce `no-explicit-any` warnings module by module
- Rule: no broad `any` replacement; each PR must pass typecheck/build/tests/lint
- Approach: (a) typed row-mapping DTOs for DB query results, (b) `eslint-disable-next-line` with documented rationale for interface-level `any`, (c) targeted `as unknown as T` only where provably safe

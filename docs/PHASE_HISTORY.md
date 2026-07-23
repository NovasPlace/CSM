# Phase History

- **Phase 9C — Database-Wide Compaction Observability (2026-07-21)**: Added additive PostgreSQL/SQLite attribution migrations for `compaction_metrics`; project/client/runtime and failure-stage diagnostics; safe partial recoverability-cache handling; database-wide session coverage and per-project/runtime audit breakdowns; gross savings minus production injection overhead for net measured savings. Pre-change live baseline: 390 rows from one session, 0 successful compressions, 0 verified savings. Full details: `PHASE9C_COMPACTION_OBSERVABILITY.md`.

> Archived completed-phase history. Moved out of `AGENTS.md` to keep the live agent prompt lean.
> Current state, constraints, and active work remain in `AGENTS.md`; this file is provenance only.
> Per-phase design docs live alongside this file (e.g. `PHASE3G_SQLITE_MVP.md`, `PHASE7C_REENTRY_PROTOCOL_DOCUMENTATION.md`).

## Done (Phase 1A – 4F-C)

- **Phase 1A (Config Contract)**: `.env.example` (19 env vars), `src/config.ts` with `getEnvString/getEnvBoolean/getEnvNumber`, provider-specific env vars, mode-based DB URL, `validateAndReturnConfig()`
- **Phase 1B (Logger Foundation)**: `src/logger.ts` with levels (debug/info/warn/error) and context (session/project/turn/memoryId), `src/stats-writer.ts` updated, `src/index.ts` startup/dispose paths use logger
- **Phase 1C (Index Split)**: `src/hooks-registration.ts` (466 lines) with verbatim hooks/tools/dispose; `src/index.ts` simplified to re-exports; `src/plugin-entry.ts` removed
- **Phase 1D (CI)**: `.github/workflows/ci.yml` with PostgreSQL 14 Alpine service, typecheck/build/test steps, `CSM_DATABASE_URL` env var
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
- **Phase 3B (Adapter Interface)**: `src/db/database-pool.ts` factory, `src/db/postgres-pool.ts` wrapper, `src/db/sqlite-pool.ts` adapter (`$N`→`?` translation, `::cast` stripping, `RETURNING` detection). `DatabaseProvider` type. 11 new tests (9 sqlite + 2 postgres).
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

## Done (Phase 7A – 9B + Closure)

- **Phase 7A — Re-entry Context Builder**: `src/re-entry-protocol.ts` orchestrates 8 layers with priority-based trimming, builds contextual block, preview-only mode.
- **Phase 7B — Session Start Integration**: `src/hooks/system-transform.ts` injects re-entry block on first turn (live injection default, first-turn tracking via `reentryInjected` Set). 4 new tests (all pass).
- **Phase 7C — Re-entry Protocol Documentation**: `docs/PHASE7C_REENTRY_PROTOCOL_DOCUMENTATION.md` created with purpose, injection mode, layer order, trimming behavior, safety model, diagnostics, validation checklist.
- **Phase 7 Complete**: Full test suite passes (808/808), typecheck clean, build clean, lint 7 warnings, live preview-only restart confirms no behavior change. Committed `aa352f2`.
- **Phase 8A-Impl — Re-entry Preview Adapter + Tool**: `src/reentry-ux-tool.ts` — `csm_reentry_preview` tool. Tool count 31→32. Committed `4b7c2f1`.
- **Phase 8B — Re-entry Live Enablement Controls**: `CSM_REENTRY_*` env vars → config → protocol. Live injection is now the default; set `CSM_REENTRY_PREVIEW_ONLY=true` only for explicit preview testing. Committed `2504d81`.
- **Phase 9A — Agent Onboarding Startup Packet**: `src/agent-onboarding.ts` — 10-provider orchestrator (identity-brief, project-continuity, phase-checkpoint, constraints, relevant-memories, promoted-beliefs, advisories, tool-guidance, handoff-state, readiness-summary). `src/agent-onboarding-tool.ts` — `csm_onboard_agent` tool. Constitutional identity (Prime Directive, hardwired instincts, wake signal). Atlas-style session continuity in handoff (latest session, work journal, open threads, checkpoints). `.env` loader added to `config.ts`. Injected FIRST in system-transform before all other blocks. 34 tests. 903/903 pass. Committed `12f1d48` + `54f35bd`.
- **Phase 8D — Belief Underflow Fix**: `belief_knowledge_store` schema REAL→DOUBLE PRECISION migration. `consolidate()` crash isolation. `sanitizeFloat()` non-finite guard. 4 regression tests.
- **Phase 9A-Tune — Onboarding Continuity Tuning**: Handoff provider rewritten for workfolder session continuity (Atlas pattern). Readiness summary reframed as continuation. Cold-start source attribution diagnostic added to system-transform.ts.
- **Phase 9B — Onboarding Quality + Telemetry**: Context injection telemetry schema (`context_injection_events`, `context_injection_items`). Compaction telemetry audit with dialect-neutral availability union. Production telemetry writer with 3 statuses. SQLite compaction_metrics migration. Observation window opened. Migration `20260712-024-context-injection-telemetry` cherry-picked from `phase9b` branch.
- **Migration Reconciliation (2026-07-13)**: DB had migration 024 applied from `phase9b` branch but current branch (`codex/csm-four-finding-correction`) lacked the source. Plugin failed to load with "unknown migration". Fixed by cherry-picking `26e11cb` — bringing migration source into the branch rather than deleting the ledger row. Migration 023 `acceptedLegacyChecksums` fix preserved. 1551/1551 tests pass, 0 errors, 7 warnings.
- **Capability Promotion Closure**: All 7 criteria implemented, independently reviewed, cross-database verified (SQLite + PostgreSQL, 109/109 tests pass). Migration 023 rewrites 5 existing promoted capabilities to provenance snapshot format. Pipeline unblocked — no longer administratively blocked.

## Phase 1G Completion Status
- ✅ hooks-registration.ts split: 423 LOC → 134 LOC (under 200)
- ✅ hooks/event-hooks.ts: 125 LOC, hooks/tool-hooks.ts: 49 LOC, hooks/dispose-hooks.ts: 82 LOC
- ✅ Replaced getter-based state with plain sessionState object
- ✅ Removed ~20 unused imports (warnings 271 → 251)

## Pre-existing Test Debt (Resolved)
- ~~**1 failing test**: `test/backfill-recall-telemetry.test.ts` line 209 — "protects old recalled memories while still surfacing old unrecalled ones" fails because prune-protection by recall count is not working for PG. Present since Phase 3B (`ae5e309`). Not caused by Phase 3D changes. Root cause: `pruneMemories`/`loadPruneRows` recall_count LATERAL join returns 0 even when `memory_recall_events` rows exist. Needs investigation in prune-scorer logic.~~
- **Resolved in Phase 3H**: Root cause was `pg` returning `COUNT(*)` as string (bigint). `typeof r.recall_count === 'number'` was always false, so recallCount defaulted to 0. Fixed by using `Number()` cast instead of `typeof` check.

## Capability Promotion Closure Criteria

All seven criteria are **implemented, independently reviewed, and cross-database verified** (SQLite + PostgreSQL, 109/109 tests pass, 2026-07-11).

1. **Failure lowers self-model without second source of truth** — ✅ PASS. `self-model-updater.ts:209-212` decreases confidence and increments failureCount. SelfModelUpdater writes only to `self_model_capabilities`, never to `memories`. Test: `capability-promotion-closure.test.ts:138-161`.
2. **Failure packets survive filtering** — ✅ PASS. `isJunkBelief()` junks only `tool:*:ok` (polarity check), not `tool:*:fail`. Test: `capability-promotion-closure.test.ts:169-213`.
3. **Success and failure reconcile under one canonical proposition** — ✅ PASS. `deriveSubject()` maps both `tool:edit:ok` and `tool:edit:fail` to `tool:edit:reliability`. `deriveStance()`: `:ok`→supports, `:fail`→opposes. Test: `capability-promotion-closure.test.ts:221-266`.
4. **Historical promotion records are snapshots, not current assertions** — ✅ PASS. Promotion content: `[Capability provenance] Capability for X crossed promotion threshold at TIME based on N reinforcements across S sessions. [Snapshot — self-model holds current live state.]`. Metadata includes `record_type: 'capability_provenance'`. Test: `capability-promotion-closure.test.ts:274-335`.
5. **Promotion does not double-count evidence** — ✅ PASS. `createMemoryFromCandidate()` calls only `memoryManager.saveMemory()` and `markCandidateApplied()`. No SQL against `self_model_capabilities`. Test: `capability-promotion-closure.test.ts:342-389`.
6. **Repeated promotion blocked by structural key** — ✅ PASS. `findDuplicate()` queries `metadata->>'dedup_key'` structurally, not `LOWER(content) LIKE`. Migration 023 idempotent via `record_type` metadata marker. Tests: `capability-promotion-closure.test.ts:396-451`, `capability-provenance-migration.test.ts`.
7. **Confidence can recover after later successes** — ✅ PASS. Success adds `(1 - confidence) * incrementRate` (monotonic increase). Test: `capability-promotion-closure.test.ts:458-501` — failure drops confidence, three subsequent successes each produce strictly increasing values, final > post-failure, respects 0.9 cap.

### Existing Promoted Capabilities (migrated to provenance by migration 023)
| Memory ID | Capability | Candidate ID | Confidence | Reinforcements |
|---|---|---|---|---|
| #68510 | edit | 20977 | 0.80 | 7 |
| #68511 | write | — | 0.70 | 6 |
| #68512 | read | — | 0.70 | 6 |
| #68513 | bash | — | 0.70 | 6 |
| #68514 | grep | — | 0.70 | 6 |

Migration 023 (`20260711-023-capability-provenance-rewrite`) rewrites these records to provenance snapshot format with `record_type: 'capability_provenance'` and `canonical_key: 'tool:X:reliability'`. Migration is idempotent — second run reports `alreadyMigrated: 5, migrated: 0`.

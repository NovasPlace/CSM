## Goal
- Framework Hardening Phase 1 complete; Phase 2A/2B/2C/2D complete; Phase 3A/3B/3C/3D/3F/3G/3H/3I complete; lint baseline locked at 249 warnings

## Constraints & Preferences
- Each sub-phase is behavior-preserving, boring, verbatim moves first
- CSM_EMBEDDING_PROVIDER (ollama|openai), OPENAI_API_KEY, OLLAMA_HOST
- Database URL: dev/test=localhost, production=explicit flag
- CI with Postgres service container
- ESLint rules start as warnings, tighten later
- Lint warning baseline: **140 warnings** (max-warnings=140 prevents unbounded growth)
- `caughtErrorsIgnorePattern: '^_'` added to `@typescript-eslint/no-unused-vars` — catch blocks with `_err` are allowed
- `better-sqlite3` doesn't support `?NNN` format with spread `.run()` — must use anonymous `?` parameters
- SQLite schema: TEXT for timestamps/JSON/arrays/embeddings; INTEGER PRIMARY KEY AUTOINCREMENT for PKs
- PostgreSQL remains default; SQLite is adapter path, not rewrite; no vector search in SQLite MVP
- `memories.session_id` is nullable (FK on sessions, NULL bypasses it)

## Lint Debt Classification (Locked)
- **0 `no-console` warnings**: All 15 intentional console calls documented with `eslint-disable-next-line no-console` rationale
- **~140 `no-explicit-any` warnings**: Typed-debt — NOT mechanical cleanup. Requires per-module type-design work (typed DTOs, generic row mappers). Do not attempt blanket `any`→`unknown` replacement (proven to cause 55+ cascading build errors)
- **~7 `no-unused-vars` warnings**: External API generic params (`opentui.d.ts`) — skipped by design
- **`max-warnings=140`** — any new warning added to src/ will fail lint

## Progress
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

### In Progress
- None

### Blocked
- **`no-explicit-any` cleanup (~140 warnings)**: Blocked by cascading type errors. Requires Phase 2X (Type Debt Reduction) — per-module typed DTOs and generic row mappers, not blanket replacement.

### Pre-existing Test Debt
- ~~**1 failing test**: `test/backfill-recall-telemetry.test.ts` line 209 — "protects old recalled memories while still surfacing old unrecalled ones" fails because prune-protection by recall count is not working for PG. Present since Phase 3B (`ae5e309`). Not caused by Phase 3D changes. Root cause: `pruneMemories`/`loadPruneRows` recall_count LATERAL join returns 0 even when `memory_recall_events` rows exist. Needs investigation in prune-scorer logic.~~
- **Resolved in Phase 3H**: Root cause was `pg` returning `COUNT(*)` as string (bigint). `typeof r.recall_count === 'number'` was always false, so recallCount defaulted to 0. Fixed by using `Number()` cast instead of `typeof` check.

## Key Decisions
- Plain `sessionState` object (not getter-based wrappers) for mutable state shared across hook modules
- Embedding similarity not useful for dedup at current scale — exact content detection catches all real duplication
- Merge is exact-match-only — no embedding-based merging; no deletion; mark superseded; preserve originals
- `any`→`unknown` substitution is NOT safe at scale — requires per-file analysis and typed DTOs/generic mappers
- Lint baseline locked at 249 — new warnings fail CI; existing debt is classified and documented
- `caughtErrorsIgnorePattern: '^_'` allows `catch (_err)` without warning
- SQLite RETURNING and ON CONFLICT DO UPDATE work (SQLite 3.24+/3.35+ bundled with better-sqlite3)
- SQLite JSON ops: `json_type(col, '$.key')` replaces `col ? 'key'`; `json_extract(col, '$.key')` replaces `col->>'key'`; `json_each(col)` replaces `col && $N`
- SQLite empty-result security: `LOWER(col) LIKE LOWER($N)` replaces `col ILIKE $N`
- SQLite vector search: degraded to text search (no `<=>`/pgvector equivalent)

## Next Steps
1. Phase 2X (Type Debt Reduction): reduce `no-explicit-any` warnings module by module
2. Fix 7 fixable `no-console` warnings (auto-docs.ts x3, system-transform.ts x3, work-journal-inject.ts x1) — convert to logger

## Critical Context
- Windows/PowerShell environment: `grep`→`rg`, `wc`→manual count, `&&`/`||`→PowerShell syntax
- All checks green: typecheck, build, lint:src (0 errors, 249 warnings)
- Full test suite: **622/622 pass**
- `git restore src/` + `git restore eslint.config.mjs` restores clean working tree
- Live DB: 45,178 total memories; 37,799 active; 7,573 with embeddings
- Schema additions: `memory_merges` table, `memories.superseded_by`/`superseded_at`, `memory_recall_events`
- SQLite schema: 7 tables, all indexed — `src/schema/sqlite/index.ts`
- `src/context-compiler.ts`: 19 `any` usages — highest-risk file for `any` cleanup (compression pipeline)
- `src/checkpoint-store.ts`: `rowToCheckpoint()` uses `row: any` — needs typed DTO

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
- `package.json`: `max-warnings=140` on `lint:src`

## Remaining Test Lint Debt
- 774+ errors, 261+ warnings across test files (`**/*.{test,spec}.ts`)
- Excluded from `lint:src` with `no-console: off`, `no-explicit-any: off`, `no-unused-vars: off`

## Phase 1G Completion Status
- ✅ hooks-registration.ts split: 423 LOC → 134 LOC (under 200)
- ✅ hooks/event-hooks.ts: 125 LOC, hooks/tool-hooks.ts: 49 LOC, hooks/dispose-hooks.ts: 82 LOC
- ✅ Replaced getter-based state with plain sessionState object
- ✅ Removed ~20 unused imports (warnings 271 → 251 → 249)

## Current Lint Status
- `npm run lint:src`: 0 errors, **154 warnings** → exits 0
- `npm run lint:all`: ~774 errors + ~261 warnings across test files (excluded from lint:src)

## Phase 2X: Type Debt Reduction (Future)
- Goal: reduce `no-explicit-any` warnings module by module
- Rule: no broad `any` replacement; each PR must pass typecheck/build/tests/lint
- Approach: (a) typed row-mapping DTOs for DB query results, (b) `eslint-disable-next-line` with documented rationale for interface-level `any`, (c) targeted `as unknown as T` only where provably safe

## Goal
- SQLite MVP complete (Phase 3). Lint debt reduction complete: Phase L1+L2, L3.1-L3.5, L4-A through L4-K done. Baseline locked at **7 warnings** (all in opentui.d.ts, skipped by design).
- Phase 4 (Living State Layer) complete: experience packets, self-model, belief knowledge, advisory context-brief injection. All 4F-C requirements verified.
- Phase 9B (Onboarding Quality + Telemetry) complete: context injection telemetry schema, compaction telemetry audit, observation window active.
- Capability promotion closure: all 7 criteria implemented, independently reviewed, cross-database verified. Unblocked.
- **Observation window active** — baseline: 2026-07-13T07:54:15Z, 3 context_injection_events (1 onboarding, 2 reentry), 0 natural traffic yet. Monitoring whether CSM onboarding/re-entry improves agent cold-start continuity.

## Constraints & Preferences
- Each sub-phase is behavior-preserving, boring, verbatim moves first
- CSM_EMBEDDING_PROVIDER (ollama|openai), OPENAI_API_KEY, OLLAMA_HOST
- Database URL: dev/test=localhost, production=explicit flag
- CI with Postgres service container
- ESLint rules start as warnings, tighten later
- Lint warning baseline: **7 warnings** (max-warnings=7 prevents unbounded growth)
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
Phases 1A–4F-C, 7A–9B, L1–L4-K, and capability promotion closure are complete. Full per-phase detail (commits, schemas, test counts) is archived in `docs/PHASE_HISTORY.md`. Per-phase design docs live alongside it (e.g. `PHASE3G_SQLITE_MVP.md`, `PHASE7C_REENTRY_PROTOCOL_DOCUMENTATION.md`).

### In Progress
- **Observation Window**: Monitoring whether CSM onboarding/re-entry improves agent cold-start continuity. Baseline: 2026-07-13T07:54:15Z, 3 context_injection_events (1 onboarding, 2 reentry), 0 natural traffic yet. Next: fresh-session test with source attribution diagnostic.

### Next (not started)
- **Phase 8C — Smart Trimming**: Adaptive token budgeting.

### Blocked
- **`no-explicit-any` typed-debt (Phase L4+ remaining)**: L4-A through L4-K reduced 102→7. Remaining 7 warnings are in `opentui.d.ts` (external API types, skipped by design). Future work: typed DTOs for `checkpoint-store.ts` (row mapper), `agent-work-journal.ts`, `context-cache-runtime.ts`. Requires per-module typed DTOs and generic row mappers, not blanket replacement.
- **`no-console` cleanup (~8 warnings)**: Remaining `eslint-disable-next-line no-console` annotations in auto-docs.ts, system-transform.ts, work-journal-inject.ts. Blocked by need for logger context support or structural refactors.

## Key Decisions
- Plain `sessionState` object (not getter-based wrappers) for mutable state shared across hook modules
- Embedding similarity not useful for dedup at current scale — exact content detection catches all real duplication
- Merge is exact-match-only — no embedding-based merging; no deletion; mark superseded; preserve originals
- `any`→`unknown` substitution is NOT safe at scale — requires per-file analysis and typed DTOs/generic mappers
- Lint baseline locked at 7 — new warnings fail CI; existing debt is classified and documented
- `caughtErrorsIgnorePattern: '^_'` allows `catch (_err)` without warning
- SQLite RETURNING and ON CONFLICT DO UPDATE work (SQLite 3.24+/3.35+ bundled with better-sqlite3)
- SQLite JSON ops: `json_type(col, '$.key')` replaces `col ? 'key'`; `json_extract(col, '$.key')` replaces `col->>'key'`; `json_each(col)` replaces `col && $N`
- SQLite empty-result security: `LOWER(col) LIKE LOWER($N)` replaces `col ILIKE $N`
- SQLite vector search: degraded to text search (no `<=>`/pgvector equivalent)
- PostgreSQL `CREATE UNIQUE INDEX IF NOT EXISTS` does not upgrade existing non-unique indexes — must DROP INDEX IF EXISTS first (CSM #55513)
- **Capability ownership boundary (2026-07-11, CSM #68554)**: Self-model = authoritative live capability state. Belief knowledge = revisable claims/preferences/worldviews. Memories = evidence/provenance/lessons/snapshots — not competing live truth. `candidate_capability` should produce provenance records ("crossed threshold at time T"), not "succeeds reliably" assertions.
- **Promotion must not double-count evidence**: experience packets already update self-model; promotion should change status/provenance/eligibility only, not confidence.
- **`isJunkBelief()` over-broad filter**: `subject.startsWith('tool:')` discards both success AND failure tool beliefs. Should inspect polarity/specificity, not blanket-reject `tool:` subjects.

## Next Steps
1. **Observation window**: Run fresh-session test with source attribution diagnostic to verify CSM onboarding/re-entry contributes to cold-start continuity (not just AGENTS.md)
2. Phase 8C — Smart Trimming: adaptive token budgeting for re-entry layers
3. Phase L4+: continue typed-DTO pass on `checkpoint-store.ts`, `agent-work-journal.ts`, `context-cache-runtime.ts`
4. Fix remaining `no-console` warnings (auto-docs.ts x3, system-transform.ts x3, work-journal-inject.ts x1) — convert to logger

## Critical Context
- Windows/PowerShell environment: `grep`→`rg`, `wc`→manual count, `&&`/`||`→PowerShell syntax
- All checks green: typecheck, build, lint:src (0 errors, 7 warnings)
- Full test suite: **1551/1551 pass**
- `git restore src/` + `git restore eslint.config.mjs` restores clean working tree
- Live DB: 62,682 total memories; 38,000+ active; 7,500+ with embeddings
- Schema additions: `memory_merges` table, `memories.superseded_by`/`superseded_at`, `memory_recall_events`, `context_injection_events`, `context_injection_items`
- SQLite schema: 7 tables, all indexed — `src/schema/sqlite/index.ts`
- `src/checkpoint-store.ts`: `rowToCheckpoint()` uses `row: any` — needs typed DTO (Phase L4 target)
- Cold-start source attribution diagnostic in `src/hooks/system-transform.ts` — distinguishes CSM sources from AGENTS.md

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
- `package.json`: `max-warnings=7` on `lint:src`

## Remaining Test Lint Debt
- 774+ errors, 261+ warnings across test files (`**/*.{test,spec}.ts`)
- Excluded from `lint:src` with `no-console: off`, `no-explicit-any: off`, `no-unused-vars: off`

## Current Lint Status
- `npm run lint:src`: 0 errors, **7 warnings** (all in opentui.d.ts, skipped by design) → exits 0
- `npm run lint:all`: ~774 errors + ~261 warnings across test files (excluded from lint:src)

## Phase 2X: Type Debt Reduction (Future)
- Goal: reduce `no-explicit-any` warnings module by module
- Rule: no broad `any` replacement; each PR must pass typecheck/build/tests/lint
- Approach: (a) typed row-mapping DTOs for DB query results, (b) `eslint-disable-next-line` with documented rationale for interface-level `any`, (c) targeted `as unknown as T` only where provably safe

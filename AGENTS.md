## Goal
- Framework Hardening Phase 1 complete; Phase 2B/2A.1/2A.2 complete; lint baseline locked at 249 warnings

## Constraints & Preferences
- Each sub-phase is behavior-preserving, boring, verbatim moves first
- CSM_EMBEDDING_PROVIDER (ollama|openai), OPENAI_API_KEY, OLLAMA_HOST
- Database URL: dev/test=localhost, production=explicit flag
- CI with Postgres service container
- ESLint rules start as warnings, tighten later
- Lint warning baseline: **249 warnings** (max-warnings=249 prevents unbounded growth)
- `caughtErrorsIgnorePattern: '^_'` added to `@typescript-eslint/no-unused-vars` — catch blocks with `_err` are allowed

## Lint Debt Classification (Locked)
- **8 `no-console` warnings**: Intentional/allowlisted (benchmark, hooks, logger internal) — not to be fixed
- **~190 `no-explicit-any` warnings**: Typed-debt — NOT mechanical cleanup. Requires per-module type-design work (typed DTOs, generic row mappers). Do not attempt blanket `any`→`unknown` replacement (proven to cause 55+ cascading build errors)
- **~51 `no-unused-vars` warnings**: Mix of unused imports and unused function args — some safe to fix, some need interface conformance
- **~5 `no-case-declarations` + misc**: Minor, fixable opportunistically
- `max-warnings=249` — any new warning added to src/ will fail lint

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
- **Lint Baseline Lock**: `max-warnings=249`. Added `caughtErrorsIgnorePattern: '^_'` to ESLint config (dropped 2 catch-var warnings). Documented `any` warnings as typed-debt, `console` warnings as intentional. Confirmed: blanket `any`→`unknown` causes 55+ build errors — do not attempt.

### In Progress
- None

### Blocked
- **`no-explicit-any` cleanup (~190 warnings)**: Blocked by cascading type errors. Requires Phase 2X (Type Debt Reduction) — per-module typed DTOs and generic row mappers, not blanket replacement.

## Key Decisions
- Plain `sessionState` object (not getter-based wrappers) for mutable state shared across hook modules
- Embedding similarity not useful for dedup at current scale — exact content detection catches all real duplication
- Merge is exact-match-only — no embedding-based merging; no deletion; mark superseded; preserve originals
- `any`→`unknown` substitution is NOT safe at scale — requires per-file analysis and typed DTOs/generic mappers
- Lint baseline locked at 249 — new warnings fail CI; existing debt is classified and documented
- `caughtErrorsIgnorePattern: '^_'` allows `catch (_err)` without warning

## Next Steps
1. Phase 2X (Type Debt Reduction): reduce `no-explicit-any` warnings module by module. Rule: no broad `any` replacement. Each PR reduces warning count and keeps all checks green.
2. Fix safe `no-unused-vars` warnings (unused imports, prefixable args) to further lower baseline
3. Fix 7 fixable `no-console` warnings (auto-docs.ts x3, system-transform.ts x3, work-journal-inject.ts x1) — convert to logger
4. Run `csm_memory_merge` in dry-run on procedural/conversation, then apply
5. Proceed to Phase 2D (Quality Scoring) or 2C per remaining order

## Critical Context
- Windows/PowerShell environment: `grep`→`rg`, `wc`→manual count, `&&`/`||`→PowerShell syntax
- All checks green: typecheck, build, lint:src (0 errors, 249 warnings)
- `git restore src/` + `git restore eslint.config.mjs` restores clean working tree
- Live DB: 45,177 total memories; 7,573 with embeddings
- Schema additions: `memory_merges` table, `memories.superseded_by`/`superseded_at`
- `src/context-compiler.ts`: 19 `any` usages — highest-risk file for `any` cleanup (compression pipeline)
- `src/checkpoint-store.ts`: `rowToCheckpoint()` uses `row: any` — needs typed DTO

## Relevant Files
- `src/embedding-backfill.ts`: `EmbeddingBackfill` class — Phase 2B
- `src/dedup-detector.ts`: `DedupCandidateDetector` class — Phase 2A.1
- `src/merge-tool.ts`: `MemoryMerger` class — Phase 2A.2
- `src/maintenance-tools.ts`: wires all three maintenance tools
- `src/hooks/tool-hooks.ts`: Wires maintenance tools from pluginCtx
- `src/schema/memory-schema.ts`: `superseded_by`/`superseded_at` + `memory_merges` table
- `src/hooks-registration.ts`: 134 LOC (thin orchestrator)
- `src/hooks/event-hooks.ts`, `src/hooks/tool-hooks.ts`, `src/hooks/dispose-hooks.ts`: split hook modules
- `eslint.config.mjs`: ESLint v9 flat config, `caughtErrorsIgnorePattern: '^_'`, src strict, tests relaxed
- `package.json`: `max-warnings=249` on `lint:src`

## Remaining Test Lint Debt
- 774+ errors, 261+ warnings across test files (`**/*.{test,spec}.ts`)
- Excluded from `lint:src` with `no-console: off`, `no-explicit-any: off`, `no-unused-vars: off`

## Phase 1G Completion Status
- ✅ hooks-registration.ts split: 423 LOC → 134 LOC (under 200)
- ✅ hooks/event-hooks.ts: 125 LOC, hooks/tool-hooks.ts: 49 LOC, hooks/dispose-hooks.ts: 82 LOC
- ✅ Replaced getter-based state with plain sessionState object
- ✅ Removed ~20 unused imports (warnings 271 → 251 → 249)

## Current Lint Status
- `npm run lint:src`: 0 errors, **249 warnings** → exits 0
- `npm run lint:all`: ~774 errors + ~261 warnings across test files (excluded from lint:src)

## Phase 2X: Type Debt Reduction (Future)
- Goal: reduce `no-explicit-any` warnings module by module
- Rule: no broad `any` replacement; each PR must pass typecheck/build/tests/lint
- Approach: (a) typed row-mapping DTOs for DB query results, (b) `eslint-disable-next-line` with documented rationale for interface-level `any`, (c) targeted `as unknown as T` only where provably safe

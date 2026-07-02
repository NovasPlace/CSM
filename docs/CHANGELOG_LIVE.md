# CHANGELOG_LIVE.md

## Development Log

### 2026-07-02 — Phase 3I: SQLite MVP Release Notes

**Phase 1: Framework Hardening**
- Config contract: 19 env vars via `getEnvString/getEnvBoolean/getEnvNumber`
- Logger foundation: levels (debug/info/warn/error) with context fields
- Hook registration split: `hooks-registration.ts` → event/tool/dispose hooks
- CI pipeline: PostgreSQL 14 Alpine, typecheck/build/test steps
- Mechanical cleanup: 86 console calls → logger, 286 lint errors → 0

**Phase 2: Memory Hygiene / Governance / Quality**
- Embedding backfill: batch/offset/resume/rate-limited repair tool
- Dedup detection: exact content/title + embedding ANN (read-only)
- Safe merge: exact-match merge with `memory_merges` table, `superseded_by`/`superseded_at`
- Governance/archive: 7,379 memories archived (7,241 superseded + 138 tiny-junk)
- Lint baseline locked at 249 warnings

**Phase 3: SQLite MVP**
- Adapter interface: `DatabaseProvider` type, `DatabasePool`/`DatabaseClient`, factory dispatch
- SQLite pool: `better-sqlite3` adapter with `$N`→`?` param translation, `::cast` stripping, `RETURNING` detection
- Schema bootstrap: 7 tables (sessions, memories, memory_chunks, memory_merges, memory_quality_scores, memory_events, memory_recall_events) with indexes
- Query dialect: `QueryDialect` type + 11 helpers (`nowFn`, `ilikeExpr`, `jsonKeyExists`, etc.)
- Narrow-path dialect awareness in `MemoryManager`: CRUD, search, text fallback
- CRUD + Search contract tests: 26 shared tests passing on both backends
- Hybrid search filter fix: `type`/`tags`/`minImportance` now propagate to all sub-searchers
- Pre-existing test debt fix: `pg` COUNT(*) bigint string → `Number()` cast
- Full suite: 622/622 green

**Next up: Phase 2X Type Debt Reduction**

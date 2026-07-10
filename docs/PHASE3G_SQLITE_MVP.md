# Phase 3G — SQLite MVP Documentation + Known Gaps

> Status: **MVP complete.**
> SQLite is selectable at startup and passes all backend contract tests.
> Not yet a PG→SQLite data migration tool.

---

## 1. How to Enable SQLite Mode

Set two environment variables (or add to `.env`):

```env
CSM_DATABASE_PROVIDER=sqlite
CSM_SQLITE_PATH=.data/csm-memory.db
```

`CSM_SQLITE_PATH` is optional — defaults to `.data/csm-memory.db`.

When `CSM_DATABASE_PROVIDER=sqlite`, the `CSM_DATABASE_URL` env var is ignored entirely. SQLite uses a local file; no Postgres service needed.

---

## 2. What Works (Supported)

- **Sessions**: create, get, archive, list by project
- **Memory**: save, list, get by session, touch (access-count tracking)
- **Search**: exact prefix match via `LOWER(content) LIKE LOWER(query || '%')`
- **Filters**: `projectId`, `type`, `tags`, `minImportance`, `searchMode` (project/legacy/global)
- **Recall telemetry**: read/write `memory_recall_events`
- **Quality scores**: read/write `memory_quality_scores`
- **Memory events**: write-only event log
- **Memory graph**: extracted-entity links and related-memory lookup
- **Embeddings**: stored in TEXT column (for PG compatibility), but unused for search

All CRUD operations, list queries, and text-based search produce identical results to PostgreSQL for the same data (verified by 26 shared contract tests).

---

## 3. What Is Degraded (Graceful)

| Feature | PG behavior | SQLite behavior |
|---------|-------------|-----------------|
| Semantic search | `pgvector` cosine-distance ANN | **Text-only fallback** — returns content-matched results ordered by importance |
| Hybrid search | Vector + FTS + entity boost + RRF fusion | Skipped entirely; `textSearchFallback` used instead |
| Full-text search | `ts_rank_cd` / `websearch_to_tsquery` / GIN index | Not available; prefix `LIKE` is the text matcher |
| Embedding similarity | `<=>` operator on `vector(1536)` column | Embedding stored but never queried |

The degradation is **silent and safe** — no errors or crashes. Search results are correct (prefix-matched, properly filtered) but lack semantic ranking.

---

## 4. What Is Unsupported / Deferred

- **Vector ANN**: No pgvector equivalent in SQLite. No plan to add one in MVP.
- **FTS virtual tables**: SQLite FTS5 exists but is not wired. Could be added later for substring search.
- **Maintenance/governance PG-only paths**:
  - `csm_memory_governance_status` (uses `array_agg`, `jsonb_set`, `LATERAL`)
  - `csm_memory_backfill_embeddings` (pointless on SQLite — embeddings are unused)
  - `csm_memory_merge` (exact-content dedup — could work, not tested on SQLite)
  - `csm_memory_prune` (uses interval/date arithmetic — not tested on SQLite)
- **Data migration**: No tool exists to migrate a PG database to SQLite or vice versa.
- **Interval-heavy analytics**: `EXTRACT(EPOCH ...)` / `age()` used in governance queries are PG-specific. SQLite uses `julianday()` equivalents but those code paths are not converted.
- **Advanced runtime services**: context briefs, checkpoints, work journal, self-continuity, living state, re-entry, compaction persistence, context cache, stats export, and their dependent tools are capability-gated in SQLite mode. They require PostgreSQL schema/query support and are not silently started.

---

## 5. Verification

**Backend contract tests** (shared PG + SQLite, same assertions):

```
Phase 3E/3F contract (PostgreSQL)  — 13/13 pass
Phase 3E/3F contract (SQLite)       — 13/13 pass
─────────────────────────────────────────────
Total                               26/26 pass
```

**Full suite**:

```
622 tests, 621 pass, 1 pre-existing failure
```

The single failure (`backfill-recall-telemetry` prune-protection) is PG-only and pre-dates SQLite work.

**Lint**:

```
0 errors, 249 warnings (baseline)
```

---

## 6. Known Gaps

| Gap | Impact | Priority |
|-----|--------|----------|
| Prune-protection recall-count bug (PG) | 1 test fails | Medium |
| No FTS5 virtual table on SQLite | No substring search — prefix-only `LIKE` | Low |
| `csm_memory_merge` not tested on SQLite | Merge tool may fail on SQLite | Low |
| No PG→SQLite migration tool | Cannot switch backends after data accumulates | Low |
| Embedding stored but wasted on SQLite | Disk + API call overhead (call avoided in Phase 3F.2) | Low |

---

## 7. Architecture Notes

SQLite is an **adapter path**, not a rewrite. The codebase uses:

- `DatabaseProvider` type (`'postgres' | 'sqlite'`) — config-driven at startup
- `Database.dialect` getter — switches all dialect-sensitive code paths
- `src/db/query-dialect.ts` — 11 helper functions that emit PG or SQLite SQL
- `src/db/sqlite-pool.ts` — `better-sqlite3` wrapper with `$N`→`?` param translation and `::cast` stripping
- `src/db/postgres-pool.ts` — thin `pg.Pool` wrapper (unchanged)
- `src/database.ts` — factory dispatch to create the correct pool

Key constraints:
- No vector search on SQLite (no `<=>` / pgvector)
- TEXT columns for JSON, arrays, timestamps (no native JSONB/TSVECTOR/ARRAY)
- Foreign keys limited to what SQLite supports (enabled via `PRAGMA foreign_keys = ON`)

# Phase 3D.3 — SQLite Compatibility Status

## Goal
Document exactly what SQLite supports now, what degrades, and which PG-only query patterns remain deferred.

## Supported SQLite Path
These core memory operations are dialect-aware and work on both PG and SQLite:

- **Schema bootstrap**: `src/schema/sqlite/index.ts` — 7 tables (sessions, memories, memory_chunks, memory_merges, memory_quality_scores, memory_events, memory_recall_events), all indexed
- **Create session**: `MemoryManager.createSession()` — `nowFn()`, `toDate()` coercion
- **Save memory**: `MemoryManager.saveMemory()` — `jsonKeyExists()`, `jsonExtractText()`, `jsonParam()`, `isUniqueViolation()`
- **List memories**: `MemoryManager.listMemories()` — `jsonArrayContains()`, `jsonContainsPath()`
- **Text/exact search**: `MemoryManager.textSearchFallback()` — `ilikeExpr()`, `jsonArrayContains()`
- **Search (degraded)**: `MemoryManager.searchMemories()` — early-returns to `textSearchFallback` on SQLite
- **Touch memory**: `MemoryManager.touchMemory()` — `nowFn()`
- **Store embedding**: `MemoryManager.storeEmbedding()` — `nowFn()`
- **Quality score table**: `memory_quality_scores` in SQLite schema
- **Dedup detect**: `DedupCandidateDetector` — `jsonExtractText()`, `colInParamArray()`
- **Recall telemetry**: `recall-telemetry.ts` — `colInParamArray()`
- **Stats writer**: `StatsWriter` — `nowFn()` via `dialectFromPool()`
- **Token budget ledger**: `TokenBudgetLedger` — `nowFn()` via `dialectFromPool()`

## Degraded Behavior
- **Vector search**: disabled on SQLite (`searchMemories` returns `textSearchFallback` results). No `<=>`/pgvector equivalent.
- **Embeddings**: stored as TEXT (JSON array string `[0.1,0.2,...]`). No ANN index. Similarity computation not available.
- **Hybrid search**: `entityMatchBoost()` ILIKE patterns are dialect-aware but `@>` containment uses `json_each` subquery (slower than PG GIN index).
- **Archive operations**: `archive-superseded-duplicates.ts` and `archive-tiny-junk.ts` `applyArchive()` are dialect-aware for `now()` and `ANY()`, but `loadCandidates`/`loadCounts` in tiny-junk still use `LATERAL` joins (will fail on SQLite).

## Adapter Behavior
The SQLite adapter (`src/db/sqlite-pool.ts`) transparently handles:

| PG Pattern | SQLite Translation | Mechanism |
|---|---|---|
| `$1`, `$2`, ... | `?`, `?`, ... | `translateParams()` |
| `::type`, `::type[]`, `::jsonb`, `::vector` | stripped | `stripCasts()` regex `/::\w+(?:\[\])?/g` |
| `RETURNING *` | detected as SELECT-like query | `isReturning` regex check |
| `ON CONFLICT DO UPDATE` | native SQLite 3.24+ | passthrough |

Application-level dialect helpers (`src/db/query-dialect.ts`):

| Helper | PG | SQLite |
|---|---|---|
| `nowFn(d)` | `now()` | `datetime('now')` |
| `ilikeExpr(d, col, idx)` | `col ILIKE $N` | `LOWER(col) LIKE LOWER($N)` |
| `ilikeLiteralExpr(d, col, lit)` | `col ILIKE 'lit'` | `LOWER(col) LIKE LOWER('lit')` |
| `jsonKeyExists(d, col, key)` | `col ? 'key'` | `json_type(col, '$.key') IS NOT NULL` |
| `jsonExtractText(d, col, key)` | `col->>'key'` | `json_extract(col, '$.key')` |
| `jsonExtractValue(d, col, key)` | `col->'key'` | `json_extract(col, '$.key')` |
| `jsonArrayContains(d, col, idx)` | `col && $N` | `EXISTS(SELECT 1 FROM json_each(col) WHERE value IN (SELECT value FROM json_each($N)))` |
| `jsonContainsPath(d, col, path, idx)` | `col->'path' @> $N` | `EXISTS(SELECT 1 FROM json_each(json_extract(col, '$.path')) WHERE value IN (SELECT value FROM json_each($N)))` |
| `jsonContainsParam(d, col, idx)` | `col @> $N::jsonb` | `EXISTS(SELECT 1 FROM json_each(col) WHERE value IN (SELECT value FROM json_each($N)))` |
| `colInParamArray(d, col, idx)` | `col = ANY($N)` | `col IN (SELECT value FROM json_each($N))` |
| `paramInColArray(d, idx, col)` | `$N = ANY(col)` | `EXISTS(SELECT 1 FROM json_each(col) WHERE value = $N)` |
| `colNotInParamArray(d, col, idx)` | `col != ALL($N)` | `col NOT IN (SELECT value FROM json_each($N))` |
| `ageDaysExpr(d, col)` | `EXTRACT(EPOCH FROM (now() - col)) / 86400` | `julianday('now') - julianday(col)` |
| `isUniqueViolation(d, err)` | `err.code === '23505'` | `err.code === 'SQLITE_CONSTRAINT_UNIQUE'` |
| `jsonParam(d, value)` | passthrough | `JSON.stringify()` for arrays/objects |
| `toDate(d, value)` | Date coercion | Date coercion from TEXT |
| `parseArrayField(d, value)` | passthrough array | `JSON.parse()` from TEXT |
| `parseJsonField(d, value)` | passthrough object | `JSON.parse()` from TEXT |

## Deferred PG-isms
These PG-specific patterns are NOT yet translated and will fail if executed on SQLite. They are in maintenance/governance/utility code, not the critical memory path.

| Pattern | Files | Notes |
|---|---|---|
| `LATERAL` join | `archive-tiny-junk.ts` (`loadCounts`, `loadCandidates`) | SQLite doesn't support LATERAL; needs correlated subquery rewrite |
| `array_append(col, $N)` | `priming-engine.ts` (`linkMemories`) | SQLite: `json_insert(col, '$[#]', $N)` |
| `array_agg(col ORDER BY col)` | `merge-tool.ts` (`findDuplicateGroups`) | SQLite: `json_group_array` or `group_concat` |
| `jsonb_set(col, '{key}', 'val')` | `memory-manager.ts` (archive cleanup) | SQLite: `json_set(col, '$.key', 'val')` |
| `interval 'N days'` arithmetic | `memory-extractor.ts`, `stats-writer.ts`, `tui.ts`, `archive-tiny-junk.ts` | SQLite: `julianday` arithmetic |
| `= ANY(subquery)` | `failure-trace-store.ts` (`recallRelated`) | Needs subquery restructuring |
| `gen_random_uuid()` | `goal-schema.ts` DDL | SQLite: handled by separate schema file |
| Raw `pg.Pool` (no adapter) | `tui.ts` (`pollStats`) | Standalone diagnostic; PG-only by design |
| `BIGSERIAL`, `TIMESTAMPTZ`, `CHECK(col IN (...))` | Various inline DDL | SQLite schema file creates equivalents; inline DDL uses `IF NOT EXISTS` |

## Verification Status
- **typecheck**: pass (0 errors)
- **build**: pass
- **lint**: 0 errors, 249 warnings (baseline)
- **tests**: 595/596 pass; 1 pre-existing failure (`backfill-recall-telemetry.test.ts:209` prune-protection, PG-only, unrelated to SQLite work)

## Commits
| Slice | Commit | Description |
|---|---|---|
| 3D.2.1 | `e71d92f` | `nowFn()` + `dialectFromPool()` plumbing (10 files) |
| 3D.2.2 | `f38a524` | ILIKE compatibility (5 files) |
| 3D.2.3 | `44046ec` | JSONB operators `->>`, `->`, `@>` (8 files) |
| 3D.2.4 | `4999734` | `ANY()`/`ALL()` array operators (8 files) |
| 3D.2.5 | (no-op) | Casts already stripped by adapter `stripCasts()` |

## Next Proposed Work
1. **Phase 3E**: Shared backend contract tests — prove `createSession`, `saveMemory`, `listMemories` produce identical results on PG and SQLite
2. **Phase 3F** (optional): Maintenance query compatibility — port deferred PG-isms (`LATERAL`, `array_append`, `jsonb_set`, etc.) if SQLite maintenance tools are needed

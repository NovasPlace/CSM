# Phase 3D.2: Remaining Query Compatibility Survey

## Goal
Identify all PG-specific SQL patterns beyond the narrow-path methods already patched in Phase 3D, and plan SQLite dialect support.

## Survey Results

### 1. `now()` in SQL
Found **6 files** using SQL `now()` function:

| File | Line | Usage |
|------|------|-------|
| `embedding-backfill.ts` | 125 | `SET updated_at = now()` |
| `memory-extractor.ts` | 529, 535 | `now() - interval '7 days'`, `now() - interval '30 days'` |
| `memory-manager.ts` | 82 | `SET updated_at = now()` |
| `stats-writer.ts` | 151, 153, 154 | `now() - interval '24 hours'` (3 queries) |
| `token-budget-ledger.ts` | 57 | `SET updated_at = now()` |
| `tui.ts` | 72, 78 | `now() - interval '24 hours'` (2 queries) |

**Status:** Not yet handled in `query-dialect.ts`. Need `nowFn()` helper applied.

### 2. `ILIKE` in SQL
Found **6 files** using `ILIKE` pattern matching:

| File | Line | Usage |
|------|------|-------|
| `context-cache-store.ts` | 71 | `WHERE ... ILIKE $2` |
| `context-cache-store.ts` | 138 | Template literal: `ILIKE $${idx}` |
| `failure-trace-store.ts` | 89 | `WHERE problem ILIKE $1` |
| `hybrid-search.ts` | 75, 77, 81, 82 | Case-insensitive text matching (4 patterns) |
| `memory-manager.ts` | 590 | **Already using `ilikeExpr()` helper** ✅ |
| `self-continuity-causal-thread.ts` | 269 | `ILIKE '%decision%' OR ILIKE '%decided%' OR ILIKE '%trade-off%'` |

**Status:** `ilikeExpr()` helper exists in `query-dialect.ts` but not applied to 5 files above. Need to patch.

### 3. `::` Cast Syntax
Found **10 files** using PostgreSQL cast syntax:

| File | Line | Usage |
|------|------|-------|
| `archive-candidate-report.ts` | 113 | `$1::text IS NULL OR project_id = $1` |
| `archive-superseded-duplicates.ts` | 149 | `id = ANY($1::bigint[])` |
| `archive-tiny-junk.ts` | 170 | `memory_type = ANY($1::text[])` |
| `archive-tiny-junk.ts` | 239 | `id = ANY($1::bigint[])` |
| `bridge-ops.ts` | 162 | `$1::text IS NULL OR session_id = $1` |
| `context-cache-store.ts` | 39 | `VALUES ... $8::jsonb` |
| `context-rollover-schema.ts` | 95, 96, 97 | `$2::BIGINT`, `$3::BIGINT`, `$4::BIGINT` |
| `goal-schema.ts` | 28 | `DEFAULT now()::text` |
| `hybrid-search.ts` | 51, 55 | `$1::vector` (PG vector search) |
| `memory-governance-report.ts` | 98 | `$1::text IS NULL OR project_id = $1` |
| `memory-manager.ts` | 436 | `$1::vector` (PG vector search) |
| `teacher-trace-seeder.ts` | 38 | `$2::text IS NULL OR project_id = $2` |
| `trace-vault-ops.ts` | 49 | `$2::text IS NULL OR project_id = $2` |

**Status:** Need `castParam()` helper or parameter translation in adapter.

**Special cases:**
- `context-cache-store.ts:39` - JSONB value cast in INSERT
- `context-rollover-schema.ts` - Casting to BIGINT for token counts
- `goal-schema.ts:28` - Timestamp to text cast
- `hybrid-search.ts:51, 55, 436` - PG vector search with `<=>` operator (not supported in SQLite MVP)

### 4. JSONB Operators
Found **5 files** using PG JSONB operators:

| File | Line | Usage |
|------|------|-------|
| `context-cache-store.ts` | 84, 121, 138, 142 | `metadata->>'filePath'`, `metadata->>'source'`, `metadata->>'task'` |
| `dedup-detector.ts` | 77 | `COALESCE(metadata->>'title', '')` |
| `memory-manager.ts` | 745 | `metadata->>'archived' IS DISTINCT FROM 'true'` |
| `self-continuity-generator.ts` | 304, 343, 353, 363 | `metadata->>'synthetic_test' IS NULL OR != 'true'` |
| `self-continuity-hydrator.ts` | 70 | `metadata->>'synthetic_test' IS NULL OR != 'true'` |
| `schema\memory-schema.ts` | 147 | `ON memories (session_id, (metadata->>'messageId'))` |

**Status:** Already using `jsonExtractText()` helper in `memory-manager.ts` ✅. Need to patch 5 other files.

### 5. JSON Containment (`@>`)
Found **1 file** using JSON containment operator:

| File | Line | Usage |
|------|------|-------|
| `hybrid-search.ts` | 76, 83 | `metadata->'extracted_concepts' @> $2::jsonb` |

**Status:** Not yet handled in `query-dialect.ts`. Need `jsonContains()` helper.

### 6. SQL Functions & Clauses
Found **1 file** using `EXTRACT` function:

| File | Line | Usage |
|------|------|-------|
| `context-compilation-log.ts` | 87 | `WHERE created_at < now() - ($1 || ' days')::interval` |

**Status:** Not yet handled. Need to inline timestamp calculation.

### 7. PG Vector Search
Found **3 files** using PG `<=>` operator (cosine similarity):

| File | Line | Usage |
|------|------|-------|
| `hybrid-search.ts` | 51, 55 | `embedding <=> $1::vector` |
| `memory-manager.ts` | 436 | `embedding <=> $1::vector` |

**Status:** Not supported in SQLite MVP. Vector search degrades to text search (already handled by `searchMemories()` → `textSearchFallback()`).

### 8. Array Functions
Found **2 files** using `ANY()` with cast:

| File | Line | Usage |
|------|------|-------|
| `archive-superseded-duplicates.ts` | 149 | `id = ANY($1::bigint[])` |
| `archive-tiny-junk.ts` | 170, 239 | `memory_type = ANY($1::text[])`, `id = ANY($1::bigint[])` |

**Status:** Need `anyParam()` helper or array parameter handling in adapter.

## Categorization by Priority

### High Priority (Critical for SQLite MVP)
1. **`now()` in SQL** (6 files) - Needed for all updates/casts
2. **`ILIKE` pattern** (5 files) - Core search pattern
3. **`::text` cast** (3 files) - Used for NULL checks, optional filters
4. **JSONB extract (`->>`)** (5 files) - Core metadata access

### Medium Priority (Frequent usage, affects UX)
5. **`::bigint[]` cast** (3 files) - Used for `ANY()` array lookups
6. **`::jsonb` cast** (2 files) - JSONB values in queries
7. **`::BIGINT` cast** (3 files) - Token counts
8. **`::text` cast** (2 files) - Additional parameter casts
9. **`ANY($N::text[])`** (2 files) - Array parameter matching

### Low Priority (Specialized, less critical)
10. **JSON containment (`@>`)** (1 file) - Advanced filtering (PG only)
11. **`EXTRACT(EPOCH FROM NOW())`** (1 file) - Specialized timestamp calc
12. **`ON ... (session_id, (metadata->>'messageId'))`** (1 file) - Index creation
13. **PG vector search (`<=>`)** (3 files) - Not supported in SQLite MVP, already degraded to text search

## Implementation Plan

### Phase 3D.2.1: Add `nowFn()` helper to `query-dialect.ts`
- Replace all SQL `now()` with `nowFn()` → `datetime('now')` for SQLite, `now()` for PG
- Apply to: `embedding-backfill.ts`, `memory-extractor.ts`, `memory-manager.ts`, `stats-writer.ts`, `token-budget-ledger.ts`, `tui.ts`

### Phase 3D.2.2: Apply `ilikeExpr()` helper
- Replace raw `ILIKE $N` with `ilikeExpr(dialect, col, paramIndex)`
- Apply to: `context-cache-store.ts`, `failure-trace-store.ts`, `hybrid-search.ts`, `self-continuity-causal-thread.ts`

### Phase 3D.2.3: Add `castParam()` helper to `query-dialect.ts`
- Map `$N::text` → `$N` for SQLite (no cast needed), keep for PG
- Map `$N::bigint` → `$N` for SQLite (INTEGER)
- Map `$N::text[]` → `$N` for SQLite (use `json_each` in array check, not in adapter)
- Map `$N::BIGINT` → `$N` for SQLite (INTEGER)
- Map `$N::jsonb` → `$N` for SQLite (JSONB stored as TEXT)

### Phase 3D.2.4: Add `jsonExtractText()` helper usage
- Patch files using `metadata->>'key'` to use `jsonExtractText('metadata', 'key')`
- Apply to: `context-cache-store.ts`, `dedup-detector.ts`, `memory-manager.ts:745`, `self-continuity-generator.ts`, `self-continuity-hydrator.ts`, `schema\memory-schema.ts:147`

### Phase 3D.2.5: Add `jsonContains()` helper for JSON containment
- Handle `metadata->'key' @> $N` → SQLite: `json_each('metadata') WHERE json_extract(json_each.value, '$.key') IN (...)`
- Apply to: `hybrid-search.ts`

### Phase 3D.2.6: Add `anyParam()` helper for `ANY($N::type[])`
- Handle `id = ANY($1::bigint[])` → SQLite: `id IN (SELECT value FROM json_each($1))`
- Apply to: `archive-superseded-duplicates.ts`, `archive-tiny-junk.ts`

### Phase 3D.2.7: Handle `EXTRACT(EPOCH FROM NOW())`
- Inline timestamp calculation in SQL → `datetime('now')`
- Apply to: `context-compilation-log.ts`

### Phase 3D.2.8: Update `sqlite-pool.ts` for cast stripping
- Strip `::text`, `::bigint`, `::BIGINT`, `::jsonb`, `::text[]`, `::bigint[]` from parameter values before execution
- Keep `::vector` for PG only (no vector support in SQLite)

## Files to Modify (Summary)

### High Priority (6 files)
1. `embedding-backfill.ts` - `nowFn()` usage
2. `memory-extractor.ts` - `nowFn()` usage, inline interval calculation
3. `stats-writer.ts` - `nowFn()` usage
4. `token-budget-ledger.ts` - `nowFn()` usage
5. `tui.ts` - `nowFn()` usage
6. `self-continuity-causal-thread.ts` - `ILIKE` pattern

### Medium Priority (5 files)
7. `context-cache-store.ts` - `ILIKE` + `jsonExtractText` + `castParam` + `::jsonb`
8. `failure-trace-store.ts` - `ILIKE` pattern
9. `hybrid-search.ts` - `ILIKE` + `@>` containment + vector search (degrade to text)
10. `memory-manager.ts` - Partially done (need `nowFn()` for line 82)
11. `dedup-detector.ts` - `jsonExtractText` usage

### Low Priority (2 files)
12. `archive-superseded-duplicates.ts` - `anyParam()` usage
13. `archive-tiny-junk.ts` - `anyParam()` usage

### Special Cases (1 file)
14. `context-compilation-log.ts` - Inline `EXTRACT(EPOCH FROM NOW())`

### Schema (1 file)
15. `schema\memory-schema.ts:147` - Index creation (ignore for MVP)

## Expected Outcomes
- 9 files patched with dialect helpers
- 0 SQL `now()` calls remaining
- 4 files patched with `ILIKE` helpers
- 5 files patched with `jsonExtractText()` helpers
- 3 files patched with `anyParam()` helpers
- PG vector search degraded to text search (already handled by `searchMemories()` → `textSearchFallback()`)

## Test Coverage
- Existing SQLite tests verify behavior matches PG
- Need to add tests for new helpers in `query-dialect.ts`
- Need to verify `nowFn()`, `ilikeExpr()`, `jsonExtractText()`, `anyParam()` work correctly on both dialects

## Next Steps
1. Implement Phase 3D.2.1: `nowFn()` helper
2. Implement Phase 3D.2.2: Apply `ilikeExpr()` helper
3. Implement Phase 3D.2.3: Add `castParam()` helper
4. Implement Phase 3D.2.4: Apply `jsonExtractText()` helper
5. Implement Phase 3D.2.5: Add `jsonContains()` helper
6. Implement Phase 3D.2.6: Add `anyParam()` helper
7. Implement Phase 3D.2.7: Handle `EXTRACT(EPOCH FROM NOW())`
8. Implement Phase 3D.2.8: Update `sqlite-pool.ts` for cast stripping
9. Run full test suite, verify 595/596 pass, 1 pre-existing failure unchanged
10. Commit Phase 3D.2 completion

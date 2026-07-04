# Phase 3A — SQLite Support Design

> Status: **Design only. No implementation.**
> PostgreSQL remains the default and source of truth.
> SQLite is an adapter path, not a rewrite.

---

## 1. Motivation

The biggest adoption barrier is PostgreSQL + pgvector. A local, zero-config SQLite backend enables single-user / local-first deployments without Docker, a database server, or extension installation. SQLite mode targets developers who want memory persistence without infrastructure.

---

## 2. Current Architecture

### 2.1 Database Class (`src/database.ts`)

```
Database
  ├── connect()     → new pg.Pool(connectionString)
  ├── getPool()     → returns DatabasePool
  ├── disconnect()  → pool.end()
  └── initializeSchema() → initializeAllSchemas(this)
```

The `Database` class is the single entry point. It:
- Hard-imports `pg` (node-postgres)
- Constructs a `pg.Pool` from `config.databaseUrl`
- Runs a health check (`SELECT NOW()`)
- Calls `initializeAllSchemas()` which creates all tables/indexes

Every consumer calls `database.getPool()` to get a `DatabasePool` and runs raw SQL.

### 2.2 Interface Contracts (`src/types.ts:527-537`)

```ts
interface DatabasePool {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
  connect: () => Promise<DatabaseClient>;
  end: () => Promise<void>;
}

interface DatabaseClient {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
  release: () => void;
}
```

These are the **adapter boundary**. Both `pg.Pool` and `pg.PoolClient` satisfy these interfaces structurally. A SQLite adapter must implement the same interface.

### 2.3 Config Selection (`src/config.ts`)

Currently:
- `CSM_DATABASE_URL` (optional in dev, required in production)
- Defaults to `postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory`

No provider selection exists yet.

---

## 3. PostgreSQL Dependency Inventory

### 3.1 By Feature Category

| Feature | Scope | Files | SQLite Equivalent | Migration Difficulty |
|---|---|---|---|---|
| **pgvector VECTOR(N) type** | `memories.embedding`, `memory_chunks.embedding` | `schema/memory-schema.ts`, `memory-manager.ts`, `hybrid-search.ts`, `dedup-detector.ts`, `embedding-backfill.ts` | Store as JSON text (`'[0.1,0.2,...]'`); compute cosine in JS | **High** — query syntax changes |
| **HNSW index** (`vector_cosine_ops`) | `memory_chunks` only | `schema/memory-schema.ts:123` | None (brute-force scan or sqlite-vec extension) | **Medium** — omit index; add later |
| **`<=>` cosine distance operator** | 3 files | `hybrid-search.ts`, `memory-manager.ts`, `dedup-detector.ts` | JS-side cosine similarity on fetched embeddings, or `sqlite-vec` virtual table | **High** — query rewrite or post-fetch compute |
| **TSVECTOR + GENERATED column** | `memories.search_vector` | `schema/memory-schema.ts:153-158` | FTS5 virtual table | **Medium** — separate table trigger |
| **GIN(tsvector) index** | `memories` | `schema/memory-schema.ts:161` | FTS5 external content table | **Medium** |
| **to_tsvector / setweight / ts_rank_cd / websearch_to_tsquery / `@@`** | FTS search + schema | `hybrid-search.ts`, `schema/memory-schema.ts` | FTS5 `MATCH` query | **Medium** — different syntax |
| **JSONB** (columns + operators) | 20+ tables, most query files | Everywhere | `TEXT` column + `json_extract()` / `json_each()` | **High** — `@>`, `?`, `->>`, `jsonb_set`, `jsonb_array_elements` all differ |
| **TEXT[] / BIGINT[] array columns** | `tags`, `linked_memory_ids`, `files_touched`, `evidence_anchors`, `related_trace_ids` | `schema/memory-schema.ts`, `checkpoint-schema.ts`, `work-journal-schema.ts`, `failure-trace-store.ts` | JSON array or comma-separated TEXT | **Medium** — `&&`, `@>`, `= ANY()` operators differ |
| **`= ANY($1)` / `&&` array operators** | Query filters | `memory-manager.ts`, `merge-tool.ts`, `archive-tiny-junk.ts`, many | `IN (...)` or JSON functions | **Medium** |
| **BIGSERIAL** | All PK columns | All schema files | `INTEGER PRIMARY KEY AUTOINCREMENT` | **Low** — type swap |
| **TIMESTAMPTZ** | All timestamp columns | All schema files | `TEXT` (ISO 8601) or `INTEGER` (epoch) | **Low** — type swap; handle TZ in app |
| **CHECK constraints** | Enum-like columns | Most schema files | SQLite CHECK works the same | **Low** — compatible |
| **`ON DELETE CASCADE`** | FKs on child tables | Many schema files | `PRAGMA foreign_keys = ON` + explicit `ON DELETE CASCADE` | **Low** — pragma required |
| **Partial indexes (`WHERE ...`)** | 6 indexes | `schema/memory-schema.ts`, `checkpoint-schema.ts`, `goal-schema.ts` | SQLite supports partial indexes natively | **Low** — compatible |
| **`ON CONFLICT DO UPDATE/NOTHING`** | Upserts | `memory-manager.ts`, `token-budget-ledger.ts`, `embedding-backfill.ts`, others | `INSERT ... ON CONFLICT DO ...` (SQLite 3.35+) | **Low** — syntax compatible |
| **LATERAL join** | 4 files | `memory-manager.ts`, `archive-tiny-junk.ts`, `archive-candidate-report.ts`, `memory-governance-report.ts` | Correlated subquery rewrite | **Medium** — query rewrite |
| **`COUNT(*) FILTER (WHERE ...)`** | Aggregate filter | `archive-superseded-duplicates.ts` | `SUM(CASE WHEN ... THEN 1 ELSE 0 END)` | **Low** — mechanical |
| **`WITH RECURSIVE` CTE** | Graph traversal | `self-continuity-causal-thread.ts` | SQLite supports recursive CTEs natively | **Low** — compatible |
| **`DISTINCT ON`** | Dedup | `self-continuity-causal-thread.ts` | Subquery + `GROUP BY` or window function | **Medium** — query rewrite |
| **`ROW_NUMBER() OVER (...)`** | Window function | `compaction-telemetry-audit.ts` | SQLite supports window functions (3.25+) | **Low** — compatible |
| **`EXTRACT(EPOCH FROM ...)`** | Age calculations | `archive-tiny-junk.ts`, `goal-schema.ts`, `context-rollover-schema.ts` | `unixepoch()` or JS-side computation | **Low** |
| **`DO $$ BEGIN ... END $$`** (PL/pgSQL) | Idempotent migrations | `goal-schema.ts`, `context-rollover-schema.ts`, `context-cache-schema.ts`, `project-isolation-schema.ts` | Not available — use `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN` patterns | **Medium** — migration pattern change |
| **`information_schema` / `pg_catalog`** | Feature detection | `hybrid-search.ts`, `schema/memory-schema.ts`, `self-continuity-generator.ts`, `bridge-session-state.ts` | `sqlite_master` / `pragma_table_info()` | **Medium** — per-adapter introspection |
| **`to_regclass()`** | Table existence check | `bridge-session-state.ts` | Check `sqlite_master` | **Low** |
| **`INTERVAL` arithmetic** | Time window queries | Multiple files (`interval '90 days'`, etc.) | `datetime('now', '-90 days')` or JS-side | **Low** |
| **`md5()` function index** | Dedup on distilled summaries | `schema/core-schema.ts` | `hash()` function (SQLite 3.40+) or JS-side | **Low** |
| **`gen_random_uuid()`** | Checkpoint IDs | `checkpoint-schema.ts`, `goal-schema.ts` | JS-side `crypto.randomUUID()` | **Low** |
| **`GENERATED ALWAYS AS IDENTITY`** | context_cache PK | `context-cache-schema.ts` | `INTEGER PRIMARY KEY AUTOINCREMENT` | **Low** |
| **`array_agg()` / `array_append()` / `array_remove()`** | Array ops | `merge-tool.ts`, `priming-engine.ts`, `failure-trace-store.ts` | JSON manipulation or JS-side | **Medium** |
| **`jsonb_array_elements()`** | Set-returning | `memory-graph.ts` | `json_each()` | **Medium** |
| **`GREATEST()`** | Max of values | `context-cache-store.ts` | `MAX()` scalar or JS-side | **Low** |
| **`IS DISTINCT FROM`** | Null-safe comparison | `archive-superseded-duplicates.ts`, `memory-manager.ts` | `IS NOT` (SQLite supports this) | **Low** |
| **`::type` casts** | Everywhere | Everywhere | Not needed in SQLite (dynamic typing) | **Low** — strip casts |
| **`CREATE EXTENSION vector`** | pgvector bootstrap | `schema/index.ts:25` | N/A — skip entirely | **Low** |

### 3.2 Summary Counts

- **57 files** execute direct SQL in `src/`
- **24 tables** defined across 17 schema files
- **3 files** use pgvector `<=>` operator
- **1 file** uses `WITH RECURSIVE` CTE
- **4 files** use `LATERAL` joins
- **1 HNSW index** (on `memory_chunks.embedding` only)
- **20+ tables** use JSONB columns
- **5 tables** use array columns (`TEXT[]` / `BIGINT[]`)

### 3.3 Hardest Problems (Ranked)

1. **pgvector `<=>` queries** — The vector search pipeline (`hybrid-search.ts`, `memory-manager.ts`, `dedup-detector.ts`) embeds `<=>` directly in SQL `ORDER BY` and `WHERE` clauses. No abstraction layer exists. Options: (a) post-fetch JS cosine similarity, (b) `sqlite-vec` extension, (c) skip vector search entirely in MVP.

2. **JSONB operators** (`@>`, `?`, `->>`, `jsonb_set`, `jsonb_array_elements`) — Used in entity matching, metadata filtering, graph traversal. SQLite has `json_extract()` and `json_each()` but the semantics differ significantly.

3. **LATERAL joins** — 4 query sites use `LEFT JOIN LATERAL (...)` for recall-count subqueries. Must be rewritten as correlated subqueries or separate queries.

4. **Schema orchestration** — The `initializeAllSchemas()` runner has Postgres-specific DDL throughout. SQLite needs its own parallel schema initializer or a dialect-aware one.

5. **`DO $$ ... $$` blocks** — PL/pgSQL anonymous blocks for idempotent column additions. SQLite needs a different migration strategy.

---

## 4. Adapter Boundary Map

### 4.1 Current Flow (PostgreSQL only)

```
config.ts → Database(config) → pg.Pool → DatabasePool
                                         ↓
                               initializeAllSchemas()
                                         ↓
                              57 files call pool.query(rawSQL)
```

### 4.2 Proposed Flow (Dual Backend)

```
config.ts → DatabaseProvider selection
              ├── postgres: pg.Pool → PostgresPool (implements DatabasePool)
              └── sqlite:   better-sqlite3 / node:sqlite → SqlitePool (implements DatabasePool)
                                                              ↓
                                                   SqliteSchemaInitializer
                                                              ↓
                                           QueryDialect layer (optional Phase 3D)
```

### 4.3 Adapter Interface

The existing `DatabasePool` / `DatabaseClient` interfaces (`src/types.ts:527-537`) are the contract. No change needed to the interface itself — a SQLite adapter must satisfy the same shape:

```ts
// Existing interface — unchanged
interface DatabasePool {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
  connect: () => Promise<DatabaseClient>;
  end: () => Promise<void>;
}
```

**Key consideration:** `pg` uses `$1, $2, ...` parameter placeholders. SQLite uses `?` or `?1, ?2, ...`. The adapter must either:
- (a) Translate `$N` → `?N` in the query layer, or
- (b) Require all SQL to use a shared parameterization helper, or
- (c) Use `?N` format everywhere (Postgres also supports `$N`; SQLite supports `?N`)

**Recommendation:** Option (a) — translate `$N` → `?N` in the SQLite adapter's `query()` wrapper. This avoids touching all 57 SQL-emitting files.

---

## 5. Minimal Viable SQLite Mode

### 5.1 What Works

| Feature | SQLite MVP | Notes |
|---|---|---|
| CRUD (insert/update/delete memories) | ✅ | Basic SQL is compatible |
| Exact text search (ILIKE → LIKE) | ✅ | Case-insensitivity needs `COLLATE NOCASE` |
| FTS5 full-text search | ✅ | Available in most SQLite builds; separate virtual table |
| Session/context management | ✅ | All non-vector tables work |
| Checkpoints | ✅ | UUID generated JS-side |
| Work journal | ✅ | TEXT[] → JSON array |
| Governance reports | ✅ | LATERAL → correlated subquery rewrite |
| Quality scoring | ✅ | Read-only queries |
| Archive operations | ✅ | Transaction pattern compatible |

### 5.2 What's Degraded or Deferred

| Feature | SQLite MVP | Fallback |
|---|---|---|
| Vector similarity search (`<=>`) | ❌ Deferred | Fall through to FTS + entity match (hybrid-search already has 3-tier fallback) |
| HNSW index | ❌ N/A | No vector index |
| Embedding storage | 🔄 Store as JSON text | Write `'[0.1,...]'` to TEXT column; read back when needed |
| Embedding backfill | ❌ Deferred | No vector search to backfill for |
| Dedup by embedding similarity | ❌ Deferred | Exact content/title dedup still works |
| `WITH RECURSIVE` causal threads | ⚠️ Compatible but untested | Verify in Phase 3D |
| pgvector extension | ❌ N/A | Skip `CREATE EXTENSION` |

### 5.3 MVP Search Pipeline

The existing `hybridSearch()` already has graceful degradation:
1. `vectorSearch()` — **skipped** (returns empty on error)
2. `ftsSearch()` — **works** with FTS5 virtual table
3. `entityMatchBoost()` — **works** (ILIKE → LIKE with JSON extract)
4. Recency — **works** (empty stub currently)

The 3-tier fallback in `memory-manager.ts:383-475` (hybrid → vector-only → text) means SQLite gracefully falls to text/FTS search.

### 5.4 JSONB Strategy

SQLite has native JSON support via `json1` extension (compiled in by default since 3.38). The mapping:

| Postgres | SQLite |
|---|---|
| `metadata->>'key'` | `json_extract(metadata, '$.key')` |
| `metadata->'key'` | `json_extract(metadata, '$.key')` |
| `metadata ? 'key'` | `json_type(metadata, '$.key') IS NOT NULL` |
| `metadata @> '{"key": val}'::jsonb` | Custom: `EXISTS(SELECT 1 FROM json_each(metadata) WHERE ...)` or JS-side |
| `jsonb_set(metadata, '{k}', 'v')` | JS-side: modify object, write back |
| `jsonb_array_elements(metadata)` | `json_each(metadata)` |

**Recommendation:** Store JSON as TEXT. Write a thin `JsonAdapter` with dialect-specific implementations for the 4-5 most common operations. For complex containment checks (`@>`), fall back to JS-side filtering.

### 5.5 Array Column Strategy

| Postgres | SQLite |
|---|---|
| `TEXT[]` column | `TEXT` column storing JSON array `'["a","b"]'` |
| `tags && ARRAY['x']` (overlap) | JS-side: parse, check intersection |
| `= ANY($1::text[])` | Rewrite to `tags LIKE '%"x"%'` or JS-side |
| `array_append(tags, 'x')` | JS-side: parse, append, write back |
| `array_to_string(tags, ' ')` | JS-side or `json_extract` iteration |

**Recommendation:** Store arrays as JSON TEXT. Do `tags` filtering in JS for MVP. Optimize later with `json_each()` if needed.

---

## 6. Configuration Design

### 6.1 New Environment Variables

```bash
# Backend selection (default: postgres)
CSM_DATABASE_PROVIDER=postgres     # existing behavior
CSM_DATABASE_PROVIDER=sqlite       # new

# SQLite-specific (only used when provider=sqlite)
CSM_SQLITE_PATH=/path/to/memory.db  # default: ./.data/csm-memory.db

# PostgreSQL-specific (existing, unchanged)
CSM_DATABASE_URL=postgresql://...
```

### 6.2 Config Logic (`src/config.ts`)

```ts
function getDatabaseProvider(): 'postgres' | 'sqlite' {
  const provider = process.env['CSM_DATABASE_PROVIDER'] ?? 'postgres';
  if (provider !== 'postgres' && provider !== 'sqlite') {
    throw new Error(`Invalid CSM_DATABASE_PROVIDER: "${provider}". Must be "postgres" or "sqlite"`);
  }
  return provider;
}

function getSqlitePath(): string {
  return process.env['CSM_SQLITE_PATH'] ?? '.data/csm-memory.db';
}
```

### 6.3 Database Class Change

```ts
export class Database {
  private pool: DatabasePool | null = null;
  private config: PluginConfig;

  async connect(): Promise<void> {
    if (this.config.databaseProvider === 'sqlite') {
      this.pool = await createSqlitePool(this.config.sqlitePath);
    } else {
      this.pool = await createPostgresPool(this.config.databaseUrl);
    }
    await this.initializeSchema();
  }

  private async initializeSchema(): Promise<void> {
    // Dispatches to provider-specific schema initializer
    await initializeAllSchemas(this, this.config.databaseProvider);
  }
}
```

### 6.4 `.env.example` Additions

```bash
# Database backend: postgres (default) or sqlite
CSM_DATABASE_PROVIDER=postgres

# SQLite database file path (only used when CSM_DATABASE_PROVIDER=sqlite)
# Default: .data/csm-memory.db
# CSM_SQLITE_PATH=
```

---

## 7. Proposed Implementation Phases

### Phase 3A — Design (this document)
- No code changes
- Review and approve design

### Phase 3B — Adapter Interface
**Goal:** Make `Database.connect()` provider-aware without breaking PostgreSQL.

Deliverables:
- `src/database-provider.ts`: factory function `createPool(provider, config) → DatabasePool`
- `src/adapters/sqlite-pool.ts`: `SqlitePool` implementing `DatabasePool` (wraps `better-sqlite3` or `node:sqlite`)
  - `$N` → `?N` parameter translation
  - `connect()` returns a `SqliteClient` with `release()` no-op
  - `end()` closes the database handle
- `src/config.ts`: add `databaseProvider` and `sqlitePath` to `PluginConfig`
- `src/database.ts`: dispatch to provider factory
- No SQL query changes yet — just the plumbing
- Tests: `SqlitePool` satisfies `DatabasePool` contract (connect, query, end)

**Dependencies:** `better-sqlite3` (synchronous, battle-tested) or Node.js built-in `node:sqlite` (experimental in Node 22+, stable target).

**Decision needed:** `better-sqlite3` (mature, sync API needs async wrapper) vs `node:sqlite` (built-in, still experimental). Recommendation: `better-sqlite3` for stability; revisit when `node:sqlite` stabilizes.

### Phase 3C — SQLite Schema & Migrations
**Goal:** Create all tables in SQLite with correct types.

Deliverables:
- `src/schema/sqlite/` directory with SQLite-specific schema initializers:
  - `sqlite-memory-schema.ts`
  - `sqlite-session-schema.ts`
  - `sqlite-core-schema.ts`
  - etc.
- `src/schema/sqlite/index.ts`: `initializeAllSqliteSchemas(database)`
- `src/schema/index.ts`: dispatch based on provider
- Type mappings:
  - `BIGSERIAL` → `INTEGER PRIMARY KEY AUTOINCREMENT`
  - `TIMESTAMPTZ` → `TEXT` (ISO 8601)
  - `JSONB` → `TEXT` (JSON)
  - `TEXT[]` / `BIGINT[]` → `TEXT` (JSON array)
  - `VECTOR(N)` → `TEXT` (pgvector string format)
  - `TSVECTOR` → skip (use FTS5 virtual table instead)
- `PRAGMA foreign_keys = ON;` on every connection
- `PRAGMA journal_mode = WAL;` for concurrent reads
- Tests: SQLite schema creates all 22 tables; columns match expected types

### Phase 3D — SQLite Query Compatibility
**Goal:** Make existing SQL queries work against SQLite.

Approach: Rather than rewriting 57 files, introduce a **dialect layer**:

1. **Parameter translation** (in `SqlitePool.query()`): `$1, $2` → `?1, ?2` — automatic, no file changes
2. **Cast stripping** (in `SqlitePool.query()`): `::int`, `::text`, `::float`, `::vector` → stripped — regex-based, no file changes
3. **LATERAL rewrite**: 4 query sites need manual rewrite to correlated subqueries
4. **`COUNT(*) FILTER (WHERE ...)` → `SUM(CASE WHEN ...)`**: 1 file, manual rewrite
5. **`<=>` vector operator**: 3 files need conditional path (skip vector search in SQLite mode)
6. **JSONB operators** (`@>`, `?`): ~10 query sites need dialect-specific SQL
7. **Array operators** (`= ANY()`, `&&`): ~8 query sites need dialect-specific SQL
8. **FTS**: `ftsSearch()` needs a SQLite branch using FTS5 `MATCH`
9. **`EXTRACT(EPOCH FROM ...)` → `unixepoch()`**: ~4 files
10. **`interval 'N days'` → `datetime('now', '-N days')`**: ~6 files

**Strategy for items 3-10:** Create a `QueryDialect` helper:
```ts
interface QueryDialect {
  cosineDistance(embeddingCol: string, param: string): string;  // PG: `<=>`, SQLite: unsupported
  jsonExtract(column: string, key: string): string;              // PG: `->>`, SQLite: `json_extract()`
  jsonContains(column: string, param: string): string;           // PG: `@>`, SQLite: custom
  arrayAny(column: string, param: string): string;               // PG: `= ANY()`, SQLite: custom
  ftsRank(column: string, query: string): string;                // PG: `ts_rank_cd()`, SQLite: `rank`
  ageEpoch(column: string): string;                              // PG: `EXTRACT(EPOCH FROM now() - col)`, SQLite: `unixepoch()-unixepoch(col)`
  intervalDays(days: number): string;                            // PG: `interval 'N days'`, SQLite: `'-N days'`
}
```

Each query file receives the dialect from the `Database` or `Pool` and uses it to build dialect-aware SQL. This is the **highest-risk phase** — changes touch many files.

### Phase 3E — SQLite Test Suite
**Goal:** Verify SQLite backend works end-to-end.

Deliverables:
- `test/sqlite/` directory with integration tests
- **Adapter contract tests** — shared test suite that runs against both PostgreSQL and SQLite:
  - `test/contract/database-contract.test.ts` — connect, query, transaction, end
  - `test/contract/memory-crud-contract.test.ts` — create, read, update, delete memories
  - `test/contract/search-contract.test.ts` — text search works (vector search skipped on SQLite)
- **SQLite-specific tests:**
  - Schema creation (all tables, correct types)
  - JSON round-trip (write/read metadata, tags)
  - Transaction rollback
  - FTS5 search
  - Parameter translation (`$1` → `?1`)
- **Existing PostgreSQL tests:** unchanged, run against PostgreSQL only
- CI: add a `sqlite` job to `.github/workflows/ci.yml` that runs the contract tests with `CSM_DATABASE_PROVIDER=sqlite`

---

## 8. Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| `better-sqlite3` native compilation on Windows | Medium | Pre-built binaries available for all platforms; `node:sqlite` as future fallback |
| JSONB operator semantics differ subtly | High | Comprehensive contract tests; JS-side fallback for complex queries |
| `@>` containment checks miss edge cases | Medium | Unit tests for each JSONB operator translation |
| Implicit type coercion differs (PG strict vs SQLite dynamic) | Medium | Add CHECK constraints in SQLite schema; validate in app layer |
| Transaction isolation differs (SQLite is SERIALIZABLE by default in WAL) | Low | SQLite's single-writer model is fine for single-user mode |
| FTS5 not available in all SQLite builds | Low | Check `pragma compile_options` at startup; fall back to LIKE |
| Recursive CTE performance on large datasets | Low | SQLite handles recursive CTEs well; tune later |
| `DISTINCT ON` rewrite correctness | Medium | Unit tests for the causal-thread query |
| Concurrent writes (single-writer lock) | Medium | WAL mode + retry on `SQLITE_BUSY`; acceptable for single-user |

---

## 9. Decision Log

| Decision | Rationale |
|---|---|
| Store embeddings as JSON TEXT in SQLite | Avoids native extension dependency; embeddings remain write-only at app layer |
| Skip vector search in SQLite MVP | `hybridSearch()` already has 3-tier fallback; FTS + entity match is sufficient for local use |
| `$N` → `?N` translation in adapter | Zero changes to 57 SQL-emitting files |
| `better-sqlite3` over `node:sqlite` | Maturity, synchronous API (easy async wrapper), pre-built binaries |
| Separate SQLite schema files | DDL is fundamentally different; avoids conditional logic in existing files |
| `QueryDialect` helper for query compatibility | Centralizes dialect-specific SQL; each file opts in gradually |
| TEXT columns for arrays/JSON | SQLite has no native array type; JSON TEXT is standard practice |
| ISO 8601 TEXT for timestamps | Human-readable, sortable, timezone-aware |

---

## 10. Open Questions

1. **`better-sqlite3` vs `node:sqlite`?** Recommendation: `better-sqlite3`. Revisit when `node:sqlite` is stable.
2. **`sqlite-vec` extension for vector search?** Could enable vector search without pgvector. Deferred to post-MVP — adds native compilation dependency.
3. **Migration tool?** SQLite schema is created at startup (same as PG). No separate migration runner needed for MVP.
4. **Database file location?** Default `.data/csm-memory.db` (gitignored). Configurable via `CSM_SQLITE_PATH`.
5. **Multi-process access?** SQLite WAL mode supports concurrent readers + single writer. For multi-process (e.g., multiple opencode instances), use `PRAGMA busy_timeout` + retry. Document as a limitation.
6. **FTS5 vs FTS4 vs no FTS?** FTS5 is standard in modern SQLite. Check at startup; fall back to LIKE if unavailable.

---

## 11. Deliverables Checklist

- [x] Adapter boundary map (Section 4)
- [x] Query incompatibility inventory (Section 3)
- [x] Minimal viable SQLite mode definition (Section 5)
- [x] Config selection design (Section 6)
- [x] Proposed phased implementation (Section 7)
- [x] Risk assessment (Section 8)
- [ ] Review and approval

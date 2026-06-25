# AGENT_MEMORY.md

## Lessons Learned (Procedural Memory)

### 1. PostgreSQL Connection String Format
- **Lesson**: Always use full connection string with credentials in URL
- **Pattern**: `postgresql://user:pass@host:port/dbname`
- **Mistake**: Splitting host/port/user/pass into separate config fields — causes parsing bugs
- **Rule**: Single `database.url` string; parse with `pg` library

### 2. Vector Dimension Must Match Model
- **Lesson**: `text-embedding-3-small` = 1536 dimensions exactly
- **Mistake**: Creating `VECTOR(768)` or `VECTOR(3072)` — silent failures on insert
- **Rule**: Hardcode `VECTOR(1536)` in migration; validate on startup

### 3. Context Compactor Preserves Errors
- **Lesson**: Errors MUST be pinned (risk=high) or agents repeat them
- **Mistake**: Treating errors as compressible — lost failure context
- **Rule**: `ContextCompactor.classifyRisk()` returns `high` for any `error`/`stderr`/`exception`

### 4. Subconscious Distillation Needs Idempotency
- **Lesson**: Distillation runs every 5min; same tool calls processed repeatedly
- **Mistake**: Creating duplicate `distillation_log` entries
- **Rule**: Track `lastDistilledToolCallId`; only process new calls

### 5. Priming Requires Project Identity
- **Lesson**: Multiple repos on same machine need isolation
- **Mistake**: Using generic `projectId` — memories leak across projects
- **Rule**: `projectId = hash(repoRootPath)`; store in `.opencode/project-id`

### 6. Tool Distiller Groups by Intent, Not Time
- **Lesson**: Consecutive `edit` + `bash` + `edit` = one logical change
- **Mistake**: Time-window grouping splits related work
- **Rule**: `detectIntent()` returns `refactor`/`feature`/`fix`/`test`/`docs`; group by intent

### 7. Memory Extractor: Semantic + Keyword Hybrid
- **Lesson**: Pure semantic misses exact matches (function names, errors)
- **Mistake**: Only using `pgvector` similarity
- **Rule**: `memory_search` does `tsvector` keyword + `embedding <=> query` hybrid; merge results

### 8. Config: Env > Config File > Defaults
- **Lesson**: Precedence confusion causes "why isn't my config working?"
- **Mistake**: Config file ignored because env var set
- **Rule**: Document precedence clearly; log effective config on startup

---

## Conventions (Stable Project Rules)

| Area | Convention | Enforced By |
|------|------------|-------------|
| Database | Single connection pool, lazy init | `Database.getInstance()` |
| Migrations | Auto-run on plugin load, idempotent | `runMigrations()` |
| Embeddings | Batch size 100, retry 3x | `MemoryExtractor.embedBatch()` |
| Search | Hybrid (keyword 0.6 + semantic 0.4) | `MemoryManager.search()` |
| Distillation | 5min interval, max 50 groups/run | `Subconscious.distill()` |
| Priming | Top 10 memories, min 0.7 score | `ContextRecall.prime()` |
| Compaction | 80% budget trigger, pin errors | `ContextCompactor.compact()` |

---

## "Don't Repeat This Mistake" Notes

1. **Don't** add columns to `memories` table without migration — breaks existing installs
2. **Don't** call `pgvector` functions without `CREATE EXTENSION vector` — silent no-op
3. **Don't** assume `process.cwd()` = project root — use `findRepoRoot()` (walks up for `.git`)
4. **Don't** log full memory content — PII risk; log `id`, `type`, `importance` only
5. **Don't** skip `await pool.end()` on shutdown — connection leaks
6. **Don't** use `JSONB` for searchable fields — use columns + GIN indexes
7. **Don't** hardcode `localhost:5432` — support Unix sockets, Docker, cloud
8. **Don't** couple memory plugin to OpenCode internals — keep adapter boundary clean
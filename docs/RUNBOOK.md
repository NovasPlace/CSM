# RUNBOOK.md

> Operational runbook. Updated by auto-docs hook.

## Startup

1. Ensure PostgreSQL is running.
2. Set `DATABASE_URL`.
3. Ensure the `vector` extension exists.
4. Start the plugin. Schema migration is additive and now covers `memory_recall_events` as well as the core memory tables.
5. For Codex-hosted usage, import `dist/codex-bridge.js` instead of starting the OpenCode plugin hooks.

## Health Checks

### Database Connectivity

```bash
node -e "const {Pool}=require('pg');new Pool({connectionString:process.env.DATABASE_URL}).query('SELECT 1').then(r=>console.log('OK:',r.rows)).catch(e=>console.error('FAIL:',e.message))"
```

### Schema Integrity

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;
```

Expected core tables:
- `sessions`
- `memories`
- `memory_chunks`
- `memory_events`
- `memory_recall_events`
- `session_contexts`
- `goals`
- `memory_links`

### Embedding Coverage

```sql
SELECT COUNT(*) AS total, COUNT(embedding) AS with_embedding
FROM memories;
```

### Recall Telemetry Coverage

```sql
SELECT COUNT(*) AS recall_events, COUNT(DISTINCT memory_id) AS recalled_memories
FROM memory_recall_events;
```

## Common Operations

### Manual Embedding Backfill

Use the runtime tool `memory_backfill_embeddings`.

Rules:
- It only scans rows where `memories.embedding IS NULL`.
- It never runs automatically on startup.
- Start with `dryRun=true` on large legacy databases.

### Codex Bridge Bootstrap

Use `CodexMemoryBridge.connect({ databaseUrl, ...config })`.

Recommended first call per task:

```ts
const bridge = await CodexMemoryBridge.connect({ databaseUrl: process.env.DATABASE_URL });
const brief = await bridge.getContextBrief({
  projectRoot: process.cwd(),
  task: 'repair fresh schema contract drift',
});
```

Bridge operations:
- `save_memory`
- `search_memories`
- `list_memories`
- `get_context_brief`
- `recall_lessons`
- `prune_memories_dry_run`
- `backfill_missing_embeddings`
- `get_compaction_report`

### Safe Review Copy

If you need a clean throwaway copy for inspection, prefer the local helper instead of downloading a ZIP and expanding it in PowerShell.

```powershell
.\scripts\safe-review-copy.ps1
```

If you need an archive for offline review, use the helper with `-Archive`:

```powershell
.\scripts\safe-review-copy.ps1 -Archive
```

### Session Schema Repair

```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS turn_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
```

### Backup Memories

```bash
pg_dump -Fc "$DATABASE_URL" > memories_backup.dump
```

### Restore Memories

```bash
pg_restore -Fc -d cross_session_memory memories_backup.dump
```

## Monitoring Queries

### Memory Distribution by Type

```sql
SELECT memory_type, COUNT(*), AVG(importance)
FROM memories
GROUP BY memory_type
ORDER BY COUNT(*) DESC;
```

### Most Recalled Memories

```sql
SELECT memory_id, COUNT(*) AS recall_count
FROM memory_recall_events
GROUP BY memory_id
ORDER BY recall_count DESC
LIMIT 20;
```

### Concept Graph Density

```sql
SELECT jsonb_array_elements_text(shared_entities) AS concept, COUNT(*) AS links
FROM memory_links
GROUP BY concept
ORDER BY links DESC
LIMIT 20;
```

## Troubleshooting

| Problem | Check | Fix |
|---------|-------|-----|
| Hybrid search empty | `SELECT COUNT(*) FROM memories WHERE embedding IS NOT NULL` | Run explicit embedding backfill |
| Prune is too aggressive | `SELECT COUNT(*) FROM memory_recall_events` | Verify recall telemetry is being written |
| Codex starts cold every time | `npx tsx --test test/codex-bridge.test.ts` | Call `get_context_brief(projectRoot, task)` before task work |
| Fresh install behaves differently | Run `test/fresh-schema-contract.test.ts` | Repair schema/runtime drift before release |

## Test Suites

Current source of truth: `npm.cmd test` reports the exact current totals. The suite includes fresh-schema and Phase 19b integration coverage.

Representative DB-backed suites:
- `hybrid-search`
- `goal`
- `fresh-schema-contract`
- `backfill-recall-telemetry`
- `codex-bridge`
- `context-cache-store`

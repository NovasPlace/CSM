# DEBUG_NOTES.md

## Known Failure Points

### 1. PostgreSQL Connection Failures
- **Symptom**: `ECONNREFUSED` or `ENOTFOUND` on plugin load
- **Cause**: PostgreSQL not running, wrong host/port, auth failure
- **Recovery**: 
  - Verify `psql "postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory"` works
  - Check `docker ps` if using container
  - Verify `pgvector` extension: `CREATE EXTENSION IF NOT EXISTS vector;`
- **Config**: `database.url` in OpenCode config or `OPENCODE_MEMORY_DB_URL` env

### 2. Migration Failures
- **Symptom**: `relation "memories" does not exist` or column mismatch
- **Cause**: Schema drift, partial migration, manual DB edits
- **Recovery**: 
  - `DROP TABLE memories CASCADE;` then restart plugin (auto-migrates)
  - Or run migrations manually from `src/database.ts:runMigrations()`
- **Prevention**: Never edit schema manually; use `Database.migrate()`

### 3. Embedding Generation Errors
- **Symptom**: `memory_search` returns empty or throws
- **Cause**: Embedding model unavailable, dimension mismatch (expects 1536), API quota
- **Recovery**: 
  - Check `MEMORY_EMBEDDING_MODEL` env (default: `text-embedding-3-small`)
  - Verify `embedding` column is `VECTOR(1536)`
  - Disable semantic search: `semanticSearch: false` in config

### 4. Context Compaction Data Loss
- **Symptom**: Important tool output missing from context
- **Cause**: Compactor aggressively summarizes; risk labels misclassified
- **Recovery**: 
  - Increase `contextTokenBudget` in config
  - Check `ContextCompactor` risk classification logic
  - Disable: `compactContext: false`

### 5. Subconscious Distillation Stalls
- **Symptom**: Memories not distilled after many turns
- **Cause**: Interval too long, process crashed, queue backed up
- **Recovery**: 
  - Call `Subconscious.forceDistill()` manually
  - Check `subconsciousIntervalMs` config (default: 300000 = 5min)
  - Review logs for `distill` errors

### 6. Priming Returns Empty
- **Symptom**: New session has no prior context
- **Cause**: No memories match project, wrong `projectId`, recall threshold too high
- **Recovery**: 
  - Verify `projectId` matches (default: repo root hash)
  - Lower `recallThreshold` in config (default: 0.7)
  - Check `memory_list` returns data

### 7. Tool Distiller Misses Edits
- **Symptom**: `CHANGELOG_LIVE.md` not updated after code changes
- **Cause**: Distiller only groups `edit`/`write`/`bash` tools; misses `task` subagent edits
- **Recovery**: 
  - Expand `ToolDistiller.detectIntent()` to cover subagent file ops
  - Manual doc update as fallback

### 8. Memory Leak in Long Sessions
- **Symptom**: OpenCode slows, memory usage grows
- **Cause**: Unbounded `toolCallHistory` in context, distillation not keeping up
- **Recovery**: 
  - Restart OpenCode (flushes in-memory caches)
  - Reduce `maxToolCallsInContext` config
  - Enable `autoDistill: true`

---

## Error Patterns

| Error | Module | Frequency | Fix |
|-------|--------|-----------|-----|
| `password authentication failed` | database.ts | High | Check `.env` / config |
| `vector dimension mismatch` | memory-extractor.ts | Medium | Recreate table with correct dim |
| `context deadline exceeded` | context-compactor.ts | Low | Increase budget or disable |
| `no session found` | tools.ts | Medium | Ensure session initialized |

---

## Recovery Procedures

### Full Reset (Nuclear)
```bash
# Drop all data, start fresh
psql "postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory" \
  -c "DROP TABLE IF EXISTS memories, distillation_log, tool_call_groups CASCADE;"
# Restart OpenCode — plugin auto-migrates
```

### Soft Reset (Keep Memories, Fix Schema)
```bash
# Re-run migrations only
psql "postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory" \
  -f src/database.ts  # (extract migration SQL manually)
```

### Verify DB Health
```sql
-- Count memories by type
SELECT type, COUNT(*) FROM memories GROUP BY type;

-- Check embedding coverage
SELECT COUNT(*) as total, 
       COUNT(embedding) as with_embedding,
       COUNT(*) - COUNT(embedding) as missing
FROM memories;

-- Recent distillation log
SELECT * FROM distillation_log ORDER BY created_at DESC LIMIT 10;
```
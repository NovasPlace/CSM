# RUNBOOK.md

> Operational runbook. Updated by auto-docs hook.

## Startup

1. Ensure PostgreSQL is running (`docker ps` or `pg_isready`)
2. Set `DATABASE_URL` env var (default: `postgresql://postgres:postgres@localhost:5432/cross_session_memory`)
3. Ensure pgvector extension exists: `CREATE EXTENSION IF NOT EXISTS vector;`
4. Plugin auto-migrates schema on connect (sessions, memories, memory_chunks, memory_events, session_contexts)

## Health Checks

### Database Connectivity
```bash
node -e "const {Pool}=require('pg');new Pool({connectionString:process.env.DATABASE_URL}).query('SELECT 1').then(r=>console.log('OK:',r.rows)).catch(e=>console.error('FAIL:',e.message))"
```

### Schema Integrity
```sql
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
-- Expected: sessions, memories, memory_chunks, memory_events, session_contexts, goals
```

### Embedding Coverage
```sql
SELECT COUNT(*) as total, COUNT(embedding) as with_embedding FROM memories;
-- with_embedding should approach total
```

### Compaction Quality
- Check `ContextCompactor.getLastQuality()` after compaction
- `quality_score < 0.6` → compaction was rejected
- `entityRetentionPolicy < 0.8` → critical code entities being lost

### Hybrid Search Sanity
```bash
npx tsx test/benchmark-hybrid.ts
# All 5 queries should show hybrid winning over vector-only
```

## Common Operations

### Backup Memories
```bash
pg_dump -Fc "$DATABASE_URL" > memories_backup.dump
```

### Restore Memories
```bash
pg_restore -Fc -d cross_session_memory memories_backup.dump
```

### Full Data Reset
```sql
DROP TABLE IF EXISTS memories, memory_chunks, sessions, memory_events, session_contexts, goals CASCADE;
-- Restart plugin; auto-migrates
```

### Fix Stale Constraints
```sql
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_memory_type_check;
ALTER TABLE memories ADD CONSTRAINT memories_memory_type_check
  CHECK (memory_type IN ('conversation','workspace','repo','preference','lesson','episodic','procedural','concept','code','config','error'));
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_emotion_check;
ALTER TABLE memories ADD CONSTRAINT memories_emotion_check
  CHECK (emotion IN ('neutral','frustration','frustrated','success','curiosity','concern'));
```

### Add Missing Columns
```sql
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding vector(1536);
ALTER TABLE memories ADD COLUMN IF NOT EXISTS search_vector tsvector;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS directory TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title TEXT;
```

## Monitoring Queries

### Memory Distribution by Type
```sql
SELECT memory_type, COUNT(*), AVG(importance) FROM memories GROUP BY memory_type ORDER BY COUNT(*) DESC;
```

### Session Memory Volume
```sql
SELECT s.id, s.project_id, COUNT(m.id) as memory_count
FROM sessions s LEFT JOIN memories m ON m.session_id = s.id
GROUP BY s.id ORDER BY memory_count DESC LIMIT 20;
```

### Quality Score History
```sql
-- After enabling quality tracking
SELECT session_id, AVG(importance) as avg_importance
FROM memories GROUP BY session_id ORDER BY avg_importance;
```

### Concept Graph Density
```sql
-- After enabling concept extraction
SELECT mc.concept, COUNT(mc.memory_id) as links
FROM memory_concepts mc GROUP BY mc.concept ORDER BY links DESC LIMIT 20;
```

## Troubleshooting

| Problem | Check | Fix |
|---------|-------|-----|
| DB connection fails | `pg_isready -h localhost -p 5432` | Start PostgreSQL |
| Empty search results | `SELECT COUNT(*) FROM memories` | Verify data loaded |
| Low quality scores | `ContextCompactor.getLastQuality()` | Increase budget cap |
| Constraint violation | Check memory_type/emotion values | Run ALTER TABLE fix |
| Stale docs | `docs/SYSTEM_MAP.md` has stubs | Delete spam; dedup now active |
| Hybrid search empty | `embedding` column null | Re-generate embeddings |

## Test Suites

| Suite | Tests | DB Required | Focus |
|-------|-------|-------------|-------|
| auto-docs | 20 | No | Doc queue, flush, dedup |
| compaction | 13 | No | Tool output compression |
| compaction-quality | 34 | No | Entity/decision/error retention |
| context-compiler | 8 | No | Context budget, pinning |
| hybrid-search | 7 | Yes (PostgreSQL) | Vector+text+entity RRF |
| goal | 5 | Yes (PostgreSQL) | Goal tracking |
| checkpoint | 6 | No | Session snapshots |
| auto-checkpoint | 6 | No | Auto checkpoint triggers |
| context-cache | 5 | No | Cache hit/miss |
| context-rollover | 7 | No | Budget rollover |
| assistant-compactor | 3 | No | Assistant compaction |
| context-cache-store | 4 | No | Cache persistence |
| context-cache-runtime | 2 | No | Runtime cache |
| tui-adapter | 4 | No | TUI rendering |
| **Total** | **124** | | |

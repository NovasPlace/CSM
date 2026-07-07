# Phase 6B: Recall Quality Audit Tool — Implementation Plan

## Goal

Implement `csm_recall_quality_report` tool that answers: "For this project/session/window, how well did recall behave?" with a read-only, bounded SQL report.

**Constraint**: Phase 6B = read-only, bounded, report-first. No scoring, no behavioral changes.

## Input Shape

```typescript
interface RecallQualityAuditParams {
  scope?: 'project' | 'session' | 'file';
  sessionId?: string;
  filePath?: string;
  since?: string; // ISO date string (default: last 24h)
  limit?: number; // max recall events (default: 1000)
}
```

## Output Format

Human-readable text summary (6 metric categories):

```
Recall Quality Report
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Window: 2026-07-07T06:00:00Z → 2026-07-08T06:00:00Z
Scope:  project: my-project
Surfaces observed: 6/8
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Relevance
────────
Top-3 recall rate: 42% (8/19 recalled in top 3)
Mean rank: 4.2 (lower is better)
Mean Reciprocal Rank: 0.32

Recall Rate
───────────
Empty result rate: 8% (1/12 queries with 0 results)
Search recall rate: 92% (11/12 queries returned results)

Freshness
─────────
Fresh recall rate (7d): 35% (7/20 recalled memories < 7 days old)
Stale recall rate (>30d): 15% (3/20 recalled memories > 30 days old)

Stability
─────────
Duplicate recall events: 12% (4 of 34 recalls occurred >1 time)
Oscillating recall: 0% (no queries with wildly varying recall sets)

Coverage
────────
Surfaces fired: [search, list, context_recall, graph]
Missing surfaces: [vector_only, text_only, text_fallback]

Query Quality
─────────────
Empty queries: 8% (1/12 queries returned 0 results)
Text fallback rate: 5% (1/20 recall events used text fallback)
Vector health: OK (all embeddings valid)
Low-result searches (<3 results): 25% (3/12 queries returned <3 results)
```

## Metric Categories

### 1. Relevance

**Top-3 Recall Rate**:
```sql
SELECT
  COUNT(*) FILTER (WHERE rank <= 3) * 100.0 / COUNT(*) AS top3_rate
FROM memory_recall_events
WHERE recalled_at >= $since AND recalled_at < $until
```

**Mean Rank**:
```sql
SELECT
  AVG(1.0 / NULLIF(rank, 0)) AS mean_reciprocal_rank
FROM memory_recall_events
WHERE recalled_at >= $since AND recalled_at < $until AND rank > 0
```

**Mean Reciprocal Rank**:
```sql
SELECT
  AVG(1.0 / NULLIF(rank, 0)) AS mrr
FROM memory_recall_events
WHERE recalled_at >= $since AND recalled_at < $until AND rank > 0
```

### 2. Recall Rate

**Empty Result Rate**:
```sql
SELECT
  COUNT(DISTINCT query_hash) FILTER (WHERE NOT EXISTS (
    SELECT 1 FROM memory_recall_events r2
    WHERE r2.query_hash = r.query_hash AND r2.recalled_at >= $since AND r2.recalled_at < $until
  )) * 100.0 / COUNT(DISTINCT query_hash) AS empty_rate
FROM (
  SELECT DISTINCT query_hash FROM memory_recall_events
  WHERE recalled_at >= $since AND recalled_at < $until
) r
```

**Search Recall Rate**:
```sql
SELECT
  COUNT(*) * 100.0 / NULLIF(
    SELECT COUNT(*) FROM (
      SELECT DISTINCT query_hash FROM memory_recall_events
      WHERE recalled_at >= $since AND recalled_at < $until
    ),
    0
  ) AS search_recall_rate
FROM memory_recall_events
WHERE recalled_at >= $since AND recalled_at < $until
```

### 3. Freshness

**Fresh Recall Rate** (7-day window):
```sql
SELECT
  COUNT(*) FILTER (
    WHERE recalled_at >= $since
      AND recalled_at < date($since) + interval '7 days'
  ) * 100.0 / COUNT(*) AS fresh_rate
FROM memory_recall_events
WHERE recalled_at >= $since AND recalled_at < $until
```

**Stale Recall Rate** (>30-day window):
```sql
SELECT
  COUNT(*) FILTER (
    WHERE recalled_at >= date($since) - interval '30 days'
  ) * 100.0 / COUNT(*) AS stale_rate
FROM memory_recall_events
WHERE recalled_at >= $since AND recalled_at < $until
```

### 4. Stability

**Duplicate Recall Events**:
```sql
SELECT
  COUNT(*) FILTER (
    WHERE memory_id IN (
      SELECT memory_id
      FROM memory_recall_events
      WHERE recalled_at >= $since AND recalled_at < $until
      GROUP BY memory_id
      HAVING COUNT(*) > 1
    )
  ) * 100.0 / COUNT(*) AS duplicate_rate
FROM memory_recall_events
WHERE recalled_at >= $since AND recalled_at < $until
```

**Oscillating Recall** (queries with wildly varying recall sets):
```sql
-- Complex query: check for queries where recall set size varies >2x
-- Placeholder for 6B (implementation in 6C)
SELECT 0 AS oscillating_rate
```

### 5. Coverage

**Surfaces Fired**:
```sql
SELECT ARRAY_AGG(DISTINCT source) AS surfaces
FROM memory_recall_events
WHERE recalled_at >= $since AND recalled_at < $until
```

**Missing Surfaces**:
```sql
-- Expected surfaces: [search, list, context_recall, graph, vector_only, text_only, text_fallback, empty_result]
-- Missing surfaces: expected - observed
SELECT ARRAY_AGG(DISTINCT source) AS missing_surfaces
FROM (
  SELECT 'vector_only' AS source
  UNION ALL
  SELECT 'text_only'
  UNION ALL
  SELECT 'text_fallback'
  UNION ALL
  SELECT 'empty_result'
) expected
WHERE source NOT IN (
  SELECT DISTINCT source
  FROM memory_recall_events
  WHERE recalled_at >= $since AND recalled_at < $until
)
```

### 6. Query Quality

**Empty Queries** (already calculated in Recall Rate)

**Text Fallback Rate**:
```sql
SELECT
  COUNT(*) * 100.0 / COUNT(*) AS fallback_rate
FROM memory_recall_events
WHERE recalled_at >= $since AND recalled_at < $until
  AND source = 'search' -- text_fallback still uses 'search' source
```

**Vector Health**:
```sql
-- Check if all recalled memories have embeddings
SELECT
  COUNT(*) * 100.0 / NULLIF(
    SELECT COUNT(*) FROM (
      SELECT DISTINCT memory_id
      FROM memory_recall_events
      WHERE recalled_at >= $since AND recalled_at < $until
    ),
    0
  ) AS vector_health_rate
FROM memory_recall_events e
JOIN memories m ON m.id = e.memory_id
WHERE m.embedding IS NOT NULL
  AND recalled_at >= $since AND recalled_at < $until
```

**Low-Result Searches** (<3 results):
```sql
SELECT
  COUNT(DISTINCT query_hash) FILTER (
    WHERE (
      SELECT COUNT(*)
      FROM memory_recall_events
      WHERE query_hash = q.query_hash
        AND recalled_at >= $since AND recalled_at < $until
    ) < 3
  ) * 100.0 / COUNT(DISTINCT query_hash) AS low_result_rate
FROM (
  SELECT DISTINCT query_hash FROM memory_recall_events
  WHERE recalled_at >= $since AND recalled_at < $until
) q
```

## Implementation Steps

### Step 1: Update Tool Interface

Update `recall-quality-tool.ts` to match the narrower input shape:

```typescript
export interface RecallQualityAuditParams {
  scope?: 'project' | 'session' | 'file';
  sessionId?: string;
  filePath?: string;
  since?: string; // ISO date string (default: last 24h)
  limit?: number; // max recall events (default: 1000)
}
```

### Step 2: Create Report Builder

Create `RecallQualityReportBuilder` class with methods:

```typescript
class RecallQualityReportBuilder {
  async buildReport(pool: DatabasePool, params: RecallQualityAuditParams): Promise<string>
  async buildRelevanceSection(pool: DatabasePool, params: RecallQualityAuditParams): Promise<string>
  async buildRecallRateSection(pool: DatabasePool, params: RecallQualityAuditParams): Promise<string>
  async buildFreshnessSection(pool: DatabasePool, params: RecallQualityAuditParams): Promise<string>
  async buildStabilitySection(pool: DatabasePool, params: RecallQualityAuditParams): Promise<string>
  async buildCoverageSection(pool: DatabasePool, params: RecallQualityAuditParams): Promise<string>
  async buildQueryQualitySection(pool: DatabasePool, params: RecallQualityAuditParams): Promise<string>
}
```

### Step 3: Implement Each Section

Implement each metric category with bounded SQL queries.

### Step 4: Add Tool Registration

Register `csm_recall_quality_report` tool in `src/tools.ts`.

### Step 5: Write Tests

Write behavior-preserving tests:
- Empty DB (returns zeroed report)
- Project filter (scopes to projectId)
- Session filter (scopes to sessionId)
- Date filter (uses since parameter)
- Limit filter (max results)

### Step 6: Verify Lint/Stability

- Lint: 0 errors, ≤96 warnings
- Typecheck: passing
- Build: passing
- Tests: 736/737 (1 known failure remains)

## Acceptance Gates

| Gate                              | Expected                                          |
| --------------------------------- | ------------------------------------------------- |
| Tool runs read-only               | No writes, no memory updates                      |
| Empty DB works                    | Returns zeroed report, no crash                   |
| Project/session/file filters work | Scoped metrics change correctly                   |
| All 6 metric categories included  | Even if some are placeholder/unknown              |
| SQL bounded                       | `limit`, date window, no unbounded scans          |
| Existing tests stay stable        | 1 known failure remains known, no new regressions |

## Design Notes

1. **Report-first, not DTO-first**: 6B outputs text, not structured DTOs. DTOs can be added in 6C/6D.

2. **Placeholder metrics**: If SQL query returns NULL or 0, show "N/A" or "0%" with note "no data available".

3. **Bounded queries**: Always use `LIMIT` clause on large result sets to prevent unbounded scans.

4. **Empty DB handling**: If no rows exist in `memory_recall_events`, return zeroed report:
   ```
   Recall Quality Report
   Window: last 24h
   Scope:  project: my-project
   Surfaces observed: 0/8
   ```

5. **Date parsing**: Use PostgreSQL `date($since)` and interval arithmetic. SQLite: use `date()` and `strftime()`.

6. **Dialect-aware queries**: Use `query-dialect.ts` helpers for date formatting.

## References

- Phase 6A contract (PHASE6A_RECALL_QUALITY_CONTRACT.md)
- Phase 6C telemetry hooks (PHASE6C_TELEMETRY_HOOKS.md)
- AGENTS.md Phase 6B (TODO)
- memory_recall_events schema (recall-telemetry.ts)
- memories schema (memory table)

# Phase 6D — Recall Quality Scoring + Advisory Recommendations

## Goal

Turn the Phase 6B report + Phase 6C telemetry into an advisory quality layer that identifies weak recall surfaces, sparse telemetry, empty-result patterns, fallback overuse, and missing graph coverage — without changing recall behavior.

## Advisory Only

This phase is strictly read-only. It does NOT:
- Mutate memories, graph links, telemetry, or recall behavior
- Prune, promote, relink, or adjust thresholds
- Block or fail recall operations

The scoring layer produces advisory grades and recommendations for human review only.

## Grades

| Grade | Meaning | When |
|-------|---------|------|
| `healthy` | Recall quality is good | ≥50 events, no abnormal patterns, ≥3 surfaces, vector health ≥50% |
| `sparse_data` | Not enough data to score confidently | <10 events (no scoring), 10-49 events (low confidence), or SQLite (no PG-specific metrics) |
| `needs_attention` | One or more metrics outside healthy range | Empty result >50%, text fallback >40%, vector health <50%, duplicate rate >60% |
| `degraded` | Multiple severe issues | (not yet auto-assigned — reserved for future Phase 6E+ composite scoring) |
| `unknown` | No data at all | 0 recall events in window |

## Thresholds (conservative)

| Metric | Warn threshold | Grade if exceeded |
|--------|---------------|-------------------|
| Empty result rate | >50% | `needs_attention` |
| Text fallback rate | >40% | `needs_attention` |
| Vector health | <50% | `needs_attention` |
| Duplicate recall rate | >60% | `needs_attention` |
| Surface coverage | <3 surfaces | reason added (no grade change) |
| Total events | <10 | `sparse_data` (no scoring) |
| Total events | 10-49 | `sparse_data` (low confidence) |
| Graph recall | 0 events | advisory reason (no grade change) |

## Low-Traffic Handling

The scorer is deliberately conservative:
- **<10 events**: `sparse_data` — not enough data to evaluate quality
- **10-49 events**: `sparse_data` — score is provisional, downgraded from `healthy` even if metrics look good
- **50+ events**: full confidence scoring
- **0 events**: `unknown` — no recall activity in window

This avoids false failures on new sessions or quiet periods. The current live audit showing 1/8 surfaces is `sparse_data`, not `degraded`.

## Graph Recall Absence

Graph recall (source='graph') only fires when:
1. The `csm_memory_related` tool is called, OR
2. Internal code calls `getRelatedMemories()`, AND
3. The target memory has links in `memory_links`

Most memories don't have graph links (links are created during memory storage with relationship extraction). Absence of graph recall is advisory, not a failure.

## Examples

### Low-Traffic Window (sparse_data)
```
Advisory Score: SPARSE DATA (confidence: 25%)
Reasons:
  - Only 5 recall events in the window (min 10 for full scoring).
  - Only 1/8 recall surfaces fired. This is expected for low-traffic windows.
Recommendations (advisory only — no automatic action taken):
  • Sparse data is not a quality problem. The audit needs more recall activity to produce a meaningful score.
  • Try a wider window (e.g., since 7 days ago) or wait for more recall events to accumulate.
```

### Healthy Recall
```
Advisory Score: HEALTHY (confidence: 100%)
Reasons:
  - 5/8 surfaces fired, 200 events recorded, no abnormal patterns detected.
```

### Graph-Sparse State
```
Advisory Score: HEALTHY (confidence: 100%)
Reasons:
  - 4/8 surfaces fired, 100 events recorded, no abnormal patterns detected.
  - No graph recall events recorded.
Recommendations (advisory only — no automatic action taken):
  • Graph recall unavailable or unused; this may be expected if few memories have links.
```

### Fallback-Heavy State (needs_attention)
```
Advisory Score: NEEDS ATTENTION (confidence: 100%)
Reasons:
  - High text fallback rate (70%): vector search is being bypassed frequently.
Recommendations (advisory only — no automatic action taken):
  • High text fallback rate may indicate vector search degradation. Check embedding provider status (Ollama/OpenAI) and embedding dimensions.
```

### Empty-Result-Heavy State (needs_attention)
```
Advisory Score: NEEDS ATTENTION (confidence: 100%)
Reasons:
  - High empty-result rate (60%): many queries returned 0 results.
Recommendations (advisory only — no automatic action taken):
  • High empty-result rate may indicate query mismatch or missing memory coverage. Consider whether the memory store has relevant content for the queries being issued.
```

## API

```typescript
import { scoreMetrics, type RecallMetrics, type RecallQualityScore } from './recall-quality-tool.js';

const score: RecallQualityScore = scoreMetrics(metrics);
// score.grade: 'healthy' | 'sparse_data' | 'needs_attention' | 'degraded' | 'unknown'
// score.confidence: 0-1
// score.reasons: string[]
// score.recommendations: string[]
```

## SQLite Compatibility

SQLite does not support the PG-specific SQL (FILTER, interval, ARRAY_AGG) needed for metric collection. The scorer returns `sparse_data` for SQLite with a recommendation to switch to PostgreSQL. SQLite recall events are still recorded and will be scored if migrated to PG.

## Tests

`test/recall-quality-scoring.test.ts` — 13 tests covering:
- Empty telemetry → `unknown`
- Low-traffic window → `sparse_data` (not degraded)
- Empty_result with nullable memory_id accepted
- Graph recall absent → advisory (not failure)
- SQLite text-only path → `sparse_data`
- PostgreSQL vector path healthy → `healthy`
- Text fallback overuse → `needs_attention`
- High empty_result rate → `needs_attention`
- Low vector health → `needs_attention`
- Low confidence downgrade to `sparse_data`
- All 8 surfaces → `healthy`
- Input immutability (scorer doesn't mutate metrics)
- Type system grade validation

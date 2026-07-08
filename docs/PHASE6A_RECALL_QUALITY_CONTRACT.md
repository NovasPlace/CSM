# Phase 6A: Recall Quality Auditor - Scope & Contract

## Overview

**Goal**: Define the scope, metrics, and contract for a Recall Quality Auditor that measures and improves the quality of memories surfaced by the recall system (search/hybrid/recall events, list operations, graph-based recall).

**Constraint**: Phase 6A = scope definition ONLY. No behavioral changes. Pure read-only audit surface. Lint must stay ≤96 warnings, 0 errors.

## Recall Surfaces Inventory

### 1. Search Surface (memory-manager.ts:419-518)

**Entry point**: `searchMemories(options, telemetry)`
**Search paths**:
- Hybrid (default): `hybridSearch()` → vectorSearch + ftsSearch + entityMatchBoost
- Vector-only fallback: when hybrid fails
- Text-fallback: when vector fails
**Recall recording**: `recordRecallBatch()` (memory_recall_events table)
**Telemetry missing**:
- Search path taken (hybrid/vector/text)
- Empty result rate
- Ranking quality (MRR, NDCG)

### 2. List Surface (memory-manager.ts:523-609)

**Entry point**: `listMemories(options, telemetry)`
**Filters**: type, tags, date range, session, entity match
**Recall recording**: `recordRecallBatch()` (memory_recall_events table)
**Telemetry missing**:
- List quality (filters working correctly?)
- Ranking (important/recent/sortBy)
- Filter effectiveness (does query return expected?)

### 3. Graph Surface (memory-graph.ts:189-239)

**Entry point**: `getRelatedMemories(memoryId, limit)`
**Returns**: Related memories by link strength (memory_links table)
**Recall recording**: NONE
**Telemetry missing**: Graph recall rate, link quality

### 4. Text Fallback (memory-manager.ts:611-664)

**Entry point**: `textSearchFallback(options)`
**Triggers**: When vector search fails completely
**Recall recording**: `recordRecallBatch()`
**Telemetry missing**: Fallback rate, text search quality

## Existing Telemetry

### memory_recall_events (recall-telemetry.ts:20-97)

**Schema**:
- `memory_id`: which memory was recalled
- `session_id`: who queried
- `project_id`: which project
- `query_hash`: hashed query (for grouping)
- `source`: 'search' | 'list' | 'context_recall'
- `rank`: position in results (1 = top)
- `score`: relevance score
- `recalled_at`: when it was recalled

**Limitations**:
- No signal about search path taken
- No signal about empty results
- No signal about query intent/quality
- No signal about time-to-recall

### experience_packets (experience-packet.ts)

**Entry types**: tool_execution, error, milestone, decision, session_start/end, loop_signal, distill_group
**Usage**: Can capture search/tool usage context

### memory_candidate_queue (candidate-schema.ts:31-93)

**Fields**: candidate_type, memory_id, reason, confidence, source_signals, status
**Usage**: Can capture recall-related candidates (e.g., stale memories need recall)

### memory_events

**Schema**: channel, payload, session_id, created_at
**Usage**: General event bus

## Required Data Sources

### Primary (table-level)

1. **memory_recall_events**
   - Primary source for recall telemetry
   - Fields: memory_id, session_id, project_id, query_hash, source, rank, score, recalled_at

2. **memories**
   - For quality scoring (importance, type, created_at, access_count, accessed_at)
   - Fields: id, content, memory_type, importance, created_at, accessed_at, access_count, embedding, tags, metadata

3. **experience_packets**
   - Optional: search context (tool calls, args)
   - Fields: id, session_id, entry_type, signals, created_at

### Secondary (optional)

4. **memory_links**
   - For graph recall metrics
   - Fields: id, source_id, target_id, link_type, strength, created_at

5. **memory_candidates**
   - For recall-related candidates (stale, boost opportunities)
   - Fields: id, candidate_type, memory_id, reason, source_signals, status

## Recall Quality Metrics

### Core Metrics (100% coverage required)

#### 1. Relevance Metrics

**Mean Rank (MR)**:
- Formula: Mean of (1/rank) for all recalled memories
- Data: memory_recall_events.rank
- Target: < 1.5 (top results recalled frequently)

**Top-3 Recall Rate**:
- Formula: Count of recalled memories with rank ≤ 3, divided by total recalls
- Data: memory_recall_events
- Target: > 40%

**MRR (Mean Reciprocal Rank)**:
- Formula: Mean(1/rank) where rank ≤ k, normalized by k
- Data: memory_recall_events
- Target: > 0.3 (k=5)

**Reciprocal Rank Fidelity (RRF Score Distribution)**:
- Formula: Histogram of reciprocal ranks (1/rank) for top 10 results
- Data: memory_recall_events
- Target: Peaks at rank 1-3

#### 2. Recall Rate Metrics

**Empty Result Rate**:
- Formula: Count of search queries with 0 results, divided by total search queries
- Data: memory_recall_events (0 rows per query) + experience_packets (search tool executions)
- Target: < 5%

**Recall Rate per Source**:
- Formula: Recall rate for each source (search/list/context_recall/graph)
- Data: memory_recall_events.source
- Target: All sources > 80% (or at least not < 50%)

**Recall Rate per Type**:
- Formula: Recall rate for each memory type (lesson/conversation/episodic/error)
- Data: memory_recall_events joined with memories.memory_type
- Target: All types > 70%

#### 3. Freshness Metrics

**Fresh Recall Rate** (7-day window):
- Formula: Count of recalled memories created within last 7 days, divided by total recalls
- Data: memories.created_at, memory_recall_events.recalled_at
- Target: > 30%

**Stale Recall Rate** (> 30 days):
- Formula: Count of recalled memories older than 30 days, divided by total recalls
- Data: memories.created_at, memory_recall_events.recalled_at
- Target: < 20%

**Age Distribution**:
- Formula: Histogram of memory age at recall (0-7d, 8-30d, 31-90d, 90+d)
- Data: memories.created_at, memory_recall_events.recalled_at
- Target: Uniform distribution by default

#### 4. Recall Stability Metrics

**Recall Frequency Distribution**:
- Formula: Histogram of recall counts per memory (1 recall, 2 recalls, ..., 10+ recalls)
- Data: memory_recall_events (group by memory_id)
- Target: Long-tail (few heavily recalled, many occasionally recalled)

**Dead Recall Rate**:
- Formula: Count of memories recalled exactly once, never again, divided by total memories
- Data: memory_recall_events (LEFT JOIN back to count recall events)
- Target: < 20%

**Recall Consistency**:
- Formula: For same query_hash, variance in recall set size (should be consistent)
- Data: memory_recall_events (group by query_hash, count distinct memory_ids)
- Target: Low variance (std dev < 20%)

#### 5. Surface Coverage Metrics

**Surfaceable Memory Count**:
- Formula: Count of memories with embedding IS NOT NULL
- Data: memories.embedding
- Target: > 70% of total memories

**Surface Coverage by Type**:
- Formula: Surfaceable memory count per type, normalized by total count per type
- Data: memories.embedding, memories.memory_type
- Target: All types > 50% (avoid embedding gaps)

**Surface Age Gap**:
- Formula: Count of memories older than 90 days without embeddings
- Data: memories.created_at, memories.embedding
- Target: < 5%

**Recoverable Surface Gap**:
- Formula: Memories > 30 days old without embeddings that could be backfilled
- Data: memories.created_at, memories.embedding
- Target: < 10%

#### 6. Query Quality Metrics

**Search Path Distribution**:
- Formula: Count of searches using hybrid/vector/text-fallback, normalized by total
- Data: experience_packets (tool_execution tool_name='search'), hybrid-search.ts
- Target: Hybrid > 80%, Vector < 10%, Text-fallback < 10%

**Query Length Distribution**:
- Formula: Histogram of query length (1-5 chars, 6-15 chars, 16-30 chars, 30+ chars)
- Data: memory_recall_events (via query_hash + experience_packets signals)
- Target: 6-30 chars (optimal length)

**Query Type Distribution**:
- Formula: Count of autocomplete vs explicit queries
- Data: experience_packets.signals (type='autocomplete' vs explicit)
- Target: Balanced

### Derived Metrics (implementation optional)

#### 7. Ranking Quality Metrics

**Precision at k** (k=5, 10):
- Formula: Count of recalled memories relevant to query, normalized by k
- Data: memory_recall_events + relevance annotation (future)
- Target: P@5 > 0.5, P@10 > 0.7

**NDCG@k**:
- Formula: Normalized Discounted Cumulative Gain
- Data: memory_recall_events + relevance scores (future)
- Target: NDCG@10 > 0.6

#### 8. Performance Metrics

**Time-to-Recall**:
- Formula: Average time between query and recall (for user feedback loops)
- Data: experience_packets.created_at, memory_recall_events.recalled_at
- Target: < 5 seconds (per session)

**Search Latency Distribution**:
- Formula: Histogram of search response times (tool_execution exitCode timing)
- Data: experience_packets (tool execution timing)
- Target: P95 < 100ms

## Implementation Phases

### 6A: Scope Definition (DONE)
- ✅ Define metrics with formulas and data sources
- ✅ Inventory existing recall surfaces and telemetry
- ✅ Identify data sources and gaps
- ✅ Define read-only tool surface (csm_recall_quality_report)

### 6B: Read-Only Audit Surface (TODO)
- Implement `csm_recall_quality_report` tool (read-only)
- Write SQL queries for each metric
- Test against live DB (behavior-preserving)
- Phase scope: NO new columns, NO new tables, NO telemetry capture hooks
- Lint: 0 errors, ≤96 warnings

### 6C: Behavioral Telemetry Hooks (TODO)
- Wire recall telemetry into searchMemories (track search path)
- Wire recall telemetry into listMemories (track filter quality)
- Wire recall telemetry into getRelatedMemories (track graph recall)
- Add empty result detection and recording
- Add query quality signals to experience_packets
- Phase scope: ONLY telemetry capture, NO metric calculation
- Lint: 0 errors, ≤96 warnings

### 6D: Metric Calculation Engine (TODO)
- Implement MetricCalculator class with methods:
  - `calculateRelevanceMetrics()`
  - `calculateRecallRateMetrics()`
  - `calculateFreshnessMetrics()`
  - `calculateStabilityMetrics()`
  - `calculateCoverageMetrics()`
  - `calculateQueryQualityMetrics()`
- Export metrics as typed DTOs (no `any`)
- Write tests for each metric (behavior-preserving)
- Phase scope: NO metric improvement, only measurement
- Lint: 0 errors, ≤96 warnings

### 6E: Improvement Loop (TODO)
- Implement improvement suggestions (e.g., "5% stale memories, add embeddings")
- Auto-promote improvement actions to candidates
- Create "Recall Quality Score" dashboard metric
- Wire into living-state-advisor context brief
- Phase scope: BEHAVIORAL CHANGES (optimizations)
- Lint: 0 errors, ≤96 warnings

## Contract Requirements

### Behavior-Preserving Constraints

1. **No Behavioral Changes in 6A-6D**:
   - Only read queries, no writes to existing tables
   - No telemetry capture in 6A-6D
   - No optimization of search algorithms
   - No changes to recall recording (already exists)

2. **Lint Debt Lock**:
   - Must maintain 0 errors, ≤96 warnings
   - No new `no-explicit-any` warnings (typed DTOs required)
   - No new `no-console` warnings (use logger)

3. **Database Compatibility**:
   - Must work on PostgreSQL (default) and SQLite (adapter)
   - SQL must be dialect-aware (use query-dialect.ts helpers)
   - No PG-specific features in SQLite paths

4. **Test Coverage**:
   - All metrics must have at least one test case (behavior-preserving)
   - Tests must pass on both PG and SQLite
   - Integration tests with live DB (optional, can use in-memory)

### Quality Requirements

1. **Metric Accuracy**:
   - All metrics must have correct formulas (verified by audit)
   - Edge cases handled (0 results, NULL values, empty arrays)
   - Performance: metric calculation < 1 second per project

2. **Auditability**:
   - Each metric must be explainable with SQL query
   - Metric values must be cached or calculated on-demand (lazy evaluation)
   - Cache TTL: 1 hour (configurable)

3. **Tool Surface**:
   - `csm_recall_quality_report` tool must be read-only
   - Tool must accept filters (projectId, sessionId, date range, source types)
   - Tool must return structured report (typed DTOs)
   - Tool must support export formats (JSON/CSV, optional)

## Data Gaps to Address in 6B

### High Priority (must fix)

1. **Search Path Tracking**:
   - Current: hybridSearch() returns results but doesn't record path
   - Gap: Can't measure vector vs text-fallback rate
   - Fix: Add telemetry in 6C

2. **Empty Result Detection**:
   - Current: searchMemories() doesn't distinguish empty vs no results
   - Gap: Can't measure empty result rate
   - Fix: Add telemetry in 6C

3. **Query Quality Signals**:
   - Current: No query type/length signals
   - Gap: Can't measure query quality metrics
   - Fix: Add telemetry in 6C

### Medium Priority (nice to have)

4. **Graph Recall Tracking**:
   - Current: getRelatedMemories() doesn't record recall events
   - Gap: Can't measure graph recall quality
   - Fix: Add telemetry in 6C

5. **Relevance Annotation**:
   - Current: No ground truth relevance signals
   - Gap: Can't measure precision, NDCG, relevance ranking
   - Fix: Add user feedback UI in 6E

### Low Priority (future phases)

6. **Query Context**:
   - Current: Only query_hash, no intent/context
   - Gap: Can't correlate recall quality with use case
   - Fix: Add query metadata in 6C

7. **User Feedback**:
   - Current: No explicit relevance feedback
   - Gap: No ground truth for metric validation
   - Fix: Add feedback UI in 6E

## Success Criteria

### 6A (Current Phase)
- ✅ Scope definition complete
- ✅ Metrics defined with formulas
- ✅ Data sources identified
- ✅ Read-only tool surface specified
- ✅ Contract requirements documented
- ✅ Typecheck/build/lint passing (0 errors, ≤96 warnings)

### 6B (Next Phase)
- `csm_recall_quality_report` tool implemented
- All 6 core metric categories implemented
- All tests passing (behavior-preserving)
- Lint unchanged (0 errors, ≤96 warnings)
- Production schema unchanged (no new columns)

### 6C (Phase After 6B)
- Search path tracking wired in
- Empty result detection wired in
- Query quality signals captured
- Graph recall tracking wired in
- Tests passing
- Lint unchanged

### 6D (Phase After 6C)
- MetricCalculator class implemented
- All metrics calculated correctly
- Typed DTOs for all metric outputs
- Tests passing
- Lint unchanged

### 6E (Phase After 6D)
- Improvement loop implemented
- Dashboard metric created
- Living-state advisor integration
- Performance verified (metric calculation < 1s)
- A/B testing framework for improvements
- Lint unchanged

## References

- AGENTS.md Phase 6A goal
- AGENTS.md "Next Steps" section (Phase 4G+ deferred, recall audit is priority)
- AGENTS.md "Known Debt Registry" (recall quality is the #1 open debt)
- memory_recall_events schema (recall-telemetry.ts:20-44)
- hybrid-search.ts (search strategy implementation)
- memory-manager.ts (search/list entry points)
- experience-packet.ts (telemetry capture framework)
- AGENTS.md "Recall Telemetry" section (already implemented, but underutilized)

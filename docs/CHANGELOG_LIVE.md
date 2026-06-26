# CHANGELOG_LIVE.md

## Development Log

### 2026-06-26 — Phase 12: Auto-Docs Fixed
- Fixed SYSTEM_MAP.md spam (530 lines → clean table)
- Dedup logic now matches table rows (` `src/foo.ts` `) AND bold entries (`**src/foo.ts**`)
- Stub filtering: files with zero exports AND zero imports are skipped
- Windows path fix: forward-slash matching for ignored paths (docs/, dist/, node_modules/, coverage/, test/fixtures/)
- Cleaned all 5 docs: SYSTEM_MAP, DECISIONS, DEBUG_NOTES, AGENT_MEMORY, RUNBOOK
- 29/29 auto-docs tests pass
- All 117 tests passing (14 suites)

### 2026-06-26 — Phase 11: Compaction Quality Metrics
- New `src/compaction-quality.ts` with 10 metrics
- Quality score: entity * 0.35 + decision * 0.25 + warning_error * 0.25 + semantic * 0.15
- Threshold guard: reject compaction if quality < 0.7
- Integrated into `ContextCompactor.getLastQuality()`
- 34 test cases for extractors, retention, quality scoring

### 2026-06-25 — Phase 10: Hybrid Search Benchmark
- 5/5 canonical queries win with hybrid vs vector-only
- Exact code queries (time.compacted, src/tui.ts, entityMatchBoost) rank #1
- Semantic queries unchanged (no regression)
- Weight config: vector=0.35, text=0.25, entity=0.35, recency=0.05

### 2026-06-25 — Phase 9: Compaction Benchmark
- 490 messages → ~31k tokens (32% usage)
- Context stays small across long sessions

### 2026-06-25 — Phase 8: Hybrid Search Bug Fixes
- Fixed entityMatchBoost SQL: $2 param conflict (used for both LIMIT and JSONB)
- Added metadata.extracted_concepts to WHERE clause
- Increased entity boost weight from 0.15 → 0.35
- All 7 hybrid-search tests pass

### 2026-06-24 — Phase 7: Hybrid Search Layer
- Weighted RRF fusion: vector + text + entity + recency
- Entity boost for exact matches (file paths, functions, config keys, errors, env vars)
- Vector-only fallback mode

### 2026-06-24 — Phase 6: Enhanced Memory List
- Concept-based search integration
- Graph connectivity boosting

### 2026-06-23 — Phase 5: Memory Graph
- Bidirectional links with relationship types (caused, fixed, supersedes, relates, depends)
- `memory_links` table with JSONB metadata

### 2026-06-23 — Phase 4: Concept Extraction
- `extractConcepts()` from tool calls
- File paths, function names, error classes, config keys, env vars

### 2026-06-22 — Phase 3: Auto-Docs Noise Guard
- Dedup within session
- Ignored paths: docs/, dist/, node_modules/, coverage/, .git/
- Config toggle via `autoDocs` plugin config

### 2026-06-22 — Phase 2: Auto-Documentation Hooks
- `auto-docs.ts` queues updates on file edits
- `tool-execute.after` hook flushes on session end

### 2026-06-21 — Phase 1: Cross-Session PostgreSQL Memory Plugin
- Memories, sessions, checkpoints, context cache, distilled summaries
- pgvector embeddings with HNSW index
- Full test suite
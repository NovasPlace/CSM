# CHANGELOG_LIVE.md

## Development Log

### 2026-06-26 — Phase 13b: Short Tool Output Compaction + Milestone

**Milestone: Live proof of context recovery under extreme pressure**

877-message coding session reaching danger territory, then full recovery:

```
Before compaction:
  865 messages | 99,202 tokens | 76% context
  Tool calls: ~87.6%  |  Assistant: ~12%  |  User: ~0.8%

After compaction cycle:
  868–873 messages | ~12,272 tokens | ~9% context

After checkpoint expansion + hybrid search recovery:
  875–877 messages | ~16–20K tokens | 12–15% context
```

Key insight: **Tool outputs are 87% of context bloat** — not chat history.
The remaining gap was short tool outputs (<100 tokens) that the classifier
treated as non-compressible. Fix: make stale short tool outputs compressible.

Changes:
- Fixed `context-compiler.ts` classifier: short tool outputs now compressible when stale
- Added `compressShortToolOutput()` for compact single-line summaries of small outputs
- Added test coverage for short tool output compaction classification
- All 190 tests passing
- Comprehensive README rewrite reflecting full system capabilities

### 2026-06-25 — Phase 13: Memory Pruning

- `src/prune-scorer.ts` — scored memory pruning with recency/frequency/importance decay
- `src/prune-types.ts` — prune configuration and result types
- Dry-run mode with category breakdowns
- Safety: never prunes active session or checkpointed data

### 2026-06-25 — Phase 12: Goal Tracking System

- `src/goals.ts` — cross-session goal persistence (active/achieved/abandoned)
- Automatic goal promotion/demotion based on activity
- Integration with context compiler for goal-aware compaction
- Tests for lifecycle, persistence, and state transitions

### 2026-06-25 — Phase 11: Compaction Quality Metrics

- `src/compaction-quality.ts` — information-loss scoring for compaction decisions
- Category-aware compression: error/warning/note/error-code each tuned differently
- Retention policies: errors (preserve detail), warnings (compress moderately), notes (aggressive compress)
- Quality gates: reject compaction that loses critical error details
- `test/compaction-quality.test.ts` — 42 tests

### 2026-06-24 — Phase 10: Hybrid Search

- `src/hybrid-search.ts` — keyword + semantic search with intelligent fusion
- 5/5 test queries beat vector-only search
- Error names with codes, foreign key constraints exact matches
- Relevance scoring combining exact match boost + semantic similarity

### 2026-06-24 — Phase 8–9: Concept Extraction + Memory Graph

- `src/concept-extractor.ts` — automatic concept/key-phrase extraction from content
- `src/memory-graph.ts` — relationship graph between memories (supports/contradicts/extends/refines)
- Graph traversal for finding related context during search
- Integration with hybrid search for graph-aware retrieval

### 2026-06-24 — Phase 2: Auto-Documentation Hooks

- `src/hooks/auto-docs.ts` — queues doc updates on file edits, flushes on session end
- `src/hooks/doc-analyzer.ts` — validates changes, stub detection, dedup guard
- `src/hooks/doc-writer.ts` — template-based doc generation with section merging
- `docs/SYSTEM_MAP.md` — auto-maintained architecture map
- `docs/PATTERNS.md` — auto-maintained pattern catalog
- 29 tests covering hooks, analyzer, writer

### 2026-06-24 — Phase 1: Cross-Session Memory Plugin

- PostgreSQL-backed persistent memory store
- Sessions, checkpoints, context cache, distilled summaries
- Context compiler + compactor pipeline
- 190 tests total across all modules

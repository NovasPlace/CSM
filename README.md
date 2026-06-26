# Cross-Session Memory

Persistent memory plugin for OpenCode. PostgreSQL + pgvector backend with hybrid search, compaction quality guarantees, and auto-documentation.

## Architecture

```
capture → extract concepts → embed + search_vector + tags → graph links
    ↓
hybrid recall (vector + text + entity + recency)
    ↓
compact old context → measure quality → guard against drift
    ↓
prune with dry-run (age, importance, recall, graph, quality)
```

## Features

### Phase 1–3: Core Memory & Auto-Docs
- **Memory types**: conversation, workspace, repo, preference, lesson, episodic, procedural, concept, code, config, error
- **Sessions**: persistent with project context, directory, title
- **Auto-documentation hooks**: queues updates on file edits, flushes on session end
- **Noise guard**: dedup, ignored paths (docs/, dist/, node_modules/, coverage/, .git/), config toggle

### Phase 4–6: Memory Graph & Enhanced Recall
- **Concept extraction**: `extractConcepts()` from tool calls
- **Memory graph**: bidirectional links with relationship types (caused, fixed, supersedes, relates, depends)
- **Enhanced `memory_list`**: hybrid recall with concept search

### Phase 7: Hybrid Search
- **Weighted RRF fusion**: vector (0.35) + text (0.25) + entity (0.35) + recency (0.05)
- **Entity boost**: exact file paths, function names, config keys, error classes, env vars
- **5/5 benchmark queries win** vs vector-only

### Phase 8: Compaction Quality Metrics
- **10 metrics**: compression_ratio, embedding_drift, entity_retention, decision_retention, warning_error_retention, restore_success_rate, recall_success_after_compaction, tokens_saved_total, tokens_saved_per_session, quality_score
- **Quality score**: `entity * 0.35 + decision * 0.25 + warning_error * 0.25 + semantic * 0.15`
- **Threshold guard**: reject/mark unsafe if quality < 0.7

### Phase 9–10: Benchmarks
- Context: 490 messages → ~31k input tokens (32% usage)
- Hybrid search: exact code queries rank #1, no semantic regression
- All 117 tests passing (14 suites)

### Phase 11: Compaction Quality Implementation
- `src/compaction-quality.ts` — pure functions for all metrics
- Integrated into `ContextCompactor` via `getLastQuality()`
- 34 test cases covering all extractors, retention, quality scoring

### Phase 12: Auto-Docs Fixes
- Fixed SYSTEM_MAP.md spam (dedup for table rows + bold entries)
- Stub filtering (zero exports + zero imports = skip)
- Windows path compatibility (forward-slash matching)
- All 5 docs cleaned: SYSTEM_MAP, DECISIONS, DEBUG_NOTES, AGENT_MEMORY, RUNBOOK

## Setup

```bash
npm install
npm run build
```

## Running Tests

```bash
npm test                    # all 117 tests
npx tsx --test test/hybrid-search.test.ts
npx tsx --test test/compaction-quality.test.ts
npx tsx --test test/auto-docs.test.ts
```

## Key APIs

| Module | Purpose |
|--------|---------|
| `src/memory-manager.ts` | saveMemory, searchMemories, createSession, createCheckpoint |
| `src/hybrid-search.ts` | hybridSearch, vectorSearch, textSearch, entityMatchBoost |
| `src/context-compactor.ts` | compact(), getLastQuality() |
| `src/compaction-quality.ts` | measureCompactionQuality, extractEntities, extractDecisions, qualityScore |
| `src/hooks/auto-docs.ts` | queueDocUpdate, flushDocUpdates, isIgnoredPath |
| `src/hooks/doc-analyzer.ts` | analyzeChange, updateDocContent, isIgnoredForAnalysis |

## Database Schema

```sql
memories          -- core memory records
memory_chunks     -- embeddings (vector(1536))
sessions          -- session metadata
session_contexts  -- compacted context snapshots
memory_events     -- distilled summaries
memory_links      -- graph edges (caused, fixed, supersedes, relates, depends)
memory_extracts   -- extracted concepts JSONB
checkpoints       -- git-like checkpoints
context_cache     -- L2 cache for compressed context
```

## Configuration

Environment variables:
```
DATABASE_URL=postgresql://user:pass@host:5432/db
OLLAMA_URL=http://localhost:11434
EMBEDDING_MODEL=nomic-embed-text
```

## Next: Memory Prune (Dry-Run)

```text
memory_prune --dry-run
→ shows: id, reason, age, importance, recall_count, graph_links, tokens_saved, risk_level
→ archive before delete
```

## License

MIT
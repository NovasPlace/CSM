# AGENT_MEMORY.md

> Materialized memory map. Updated by auto-docs hook.
> This file is a quick-reference for the agent's own accumulated knowledge.

## Core Architecture
- **Plugin entry**: `src/index.ts` → `CrossSessionMemoryPlugin` (OpenCode `Plugin` interface)
- **Database layer**: `src/database.ts` → PostgreSQL + pgvector; schema auto-creates sessions/memories/memory_chunks/memory_events/session_contexts
- **Memory manager**: `src/memory-manager.ts` → CRUD + search (save, load, search_memories, create_session, checkpoint)
- **Embeddings**: `src/embeddings.ts` → Ollama or OpenAI; VECTOR(1536); stored in both `memories.embedding` and `memory_chunks`
- **Context compiler**: `src/context-compiler.ts` → compacts context into budget; risk labels; distilled summaries
- **Context compactor**: `src/context-compactor.ts` → compresses tool outputs; now tracks `CompactionQualityMetrics`
- **Hybrid search**: `src/hybrid-search.ts` → vector + text + entity RRF; weights: v=0.35, t=0.25, e=0.35, r=0.05
- **Compaction quality**: `src/compaction-quality.ts` → entity/decision/error retention, embedding drift, quality_score (threshold 0.6)

## Hooks
- **tool-execute.after**: fires `auto-docs.ts:queueDocUpdate()` on file writes; flushes at session end
- **auto-docs.ts**: queues, deduplicates, groups doc updates; flushes to CHANGELOG_LIVE.md
- **doc-analyzer.ts**: generates SYSTEM_MAP, DECISIONS, DEBUG_NOTES entries; now with dedup + stub filtering

## TUI Layer
- **src/tui.ts**: Solid.js Map + Compaction dashboard; renamed from .tsx; graceful failure if Solid unavailable

## Session Flow
1. Plugin loads → DB connects → schema auto-creates/migrates
2. Session starts → `createSession()` → prime memories from previous sessions
3. During session: memories saved, auto-docs queued, context compacted
4. Session end: `checkpoint()` → flush auto-docs → dispose

## Key Constraints
- **Memory types**: conversation, workspace, repo, preference, lesson, episodic, procedural, concept, code, config, error
- **Emotions**: neutral, frustration, frustrated, success, curiosity, concern
- **Quality score formula**: entity_retention×0.35 + decision_retention×0.25 + error_retention×0.25 + similarity×0.15
- **Quality threshold**: < 0.6 → compaction rejected as unsafe

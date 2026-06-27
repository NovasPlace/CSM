# Cross-Session Memory Plugin

A full-stack memory and context management system for AI coding assistants. Persists knowledge across sessions, compacts context on the fly, checkpoints progress, and auto-documents your codebase, all backed by PostgreSQL and pgvector.

## What It Does

This plugin gives an AI assistant long-term memory. Without it, every new session starts from zero. With it, the assistant remembers what it did last session, what decisions were made, what went wrong, what the codebase looks like, and where it left off.

### Memory System
- **Cross-session persistence** - Memories are stored in PostgreSQL and survive session restarts. Every session can recall, search, and build on knowledge from prior sessions.
- **Host-neutral bridge path** - The Postgres memory core can now be reached from OpenCode or from the Codex bridge export without rewriting `MemoryManager`.
- **Automatic memory extraction** - After every assistant turn, raw conversation text is distilled into structured semantic memories with no user effort.
- **Memory types** - `conversation`, `workspace`, `repo`, `preference`, `lesson`, `episodic`, and `procedural`.
- **Hybrid search** - Queries use Reciprocal Rank Fusion across vector similarity, full-text search, and entity matching.
- **Explicit recall telemetry** - Search, list, and context recall write `memory_recall_events` rows with hashed queries only. No raw query text is stored by default.
- **Concept extraction and knowledge graph** - Concepts are extracted from memory content and linked together for entity-aware recall.
- **Prune scoring** - Dry-run prune scoring now accounts for recall frequency so old but frequently used memories stay protected.
- **Manual embedding backfill** - Legacy rows with `embedding IS NULL` can be repaired explicitly through runtime/API backfill. This never runs automatically on startup.

### Context Pipeline
- **Context compilation** - Builds a token-budgeted manifest from recent work, goals, lessons, and project context.
- **Codex context brief** - `CodexMemoryBridge.getContextBrief({ projectRoot, task })` builds a compact brief plus lesson/risk recall before a fresh Codex task burns context rediscovering the repo.
- **Tool-call distillation** - Converts raw tool output into structured summaries and references.
- **Assistant text compaction** - Compresses long assistant text while preserving important lines.
- **Compaction quality gate** - Rejects unsafe compactions instead of silently dropping signal.
- **Context rollover** - Generates a continuation brief when prompt pressure gets too high.

### Checkpoint System
- **Session checkpoints** - Snapshots current work into durable PostgreSQL-backed checkpoints.
- **Auto-checkpointing** - Queues checkpoints before risky operations.
- **Checkpoint markdown** - Renders checkpoints into readable summaries for debugging and handoff.

### Self-Continuity (Phase 21)
- **Self-continuity records** - Structured records that capture what the agent knows about its own identity, continuity gaps, and evidence anchors across sessions.
- **Injection modes** - Silent (context pane) or instrumented (prompt-level) delivery of continuity context.
- **Weighted confidence** - Each record carries a confidence score based on evidence strength, recency, and source reliability.
- **Natural recall** - Proven in live experiments: agents naturally cite continuity records when asked about identity/continuity without explicit prompting.

### Self-Model Drift Tracking (Phase 22)
- **5-dimension stability metric** - Measures whether the agent's self-continuity model stabilizes or drifts across sessions.
- **Dimensions**: evidence anchoring, reconstruction boundary, uncertainty preservation, subjective overclaim, recursive awareness.
- **Anchor fixtures** - Grounded in real experiment results (Sessions A/D/E), not theoretical.
- **Verdict system** - `stable` / `mild_drift` / `significant_drift` based on weighted scoring across all dimensions.

### Safety and Monitoring
- **Loop detection** - Breaks repeated identical tool calls.
- **Git watching** - Surfaces repo changes into the context pipeline.
- **Background maintenance** - Handles cleanup, graph updates, and compaction telemetry.
- **Fresh-schema contract coverage** - Empty-database integration tests verify clean installs before release claims.

## Key Design Decisions

- **No CLI requirement** - This is runtime/API-first. Maintenance actions like embedding backfill are explicit tools, not startup jobs.
- **Thin adapter architecture** - Keep the Postgres memory core stable; add host bridges around it instead of forking runtime logic per assistant.
- **PostgreSQL + pgvector only** - No SQLite, Redis, or ORM.
- **No raw query telemetry by default** - Recall telemetry stores only hashed queries.
- **Fail closed on token overflow** - If the prompt exceeds the hard limit, the system rejects it rather than truncating context silently.

## Test Suite

Current source of truth is the test runner output. The suite includes fresh-schema and Phase 19b integration coverage for clean installs, explicit backfill, and hashed recall telemetry. 46 tests total across 9 suites.

| Suite | What It Covers |
|-------|----------------|
| `hybrid-search` | Vector + text + entity retrieval |
| `fresh-schema-contract` | Empty DB -> schema init -> runtime contract verification |
| `backfill-recall-telemetry` | Explicit embedding backfill + hashed recall telemetry |
| `codex-bridge` | Codex bridge bootstrap, context brief, and bridge/plugin parity |
| `checkpoint` | Checkpoint capture, storage, and injection |
| `prune-scorer` | Dry-run prune scoring and protection rules |
| `auto-docs` | Documentation queueing, flush, and reconciliation |
| `self-continuity` | Self-continuity records: schema, generator, injection modes, confidence weighting |
| `self-drift-tracker` | Self-model drift tracking: 5-dimension stability metric, A/D/E anchor fixtures |

Run everything:

```bash
npm run build && npm run typecheck && npx tsx --test test/*.test.ts
```

## Setup

```bash
npm install
npm run build
```

Requires a running PostgreSQL instance with pgvector extension and an embedding provider configuration.

## Codex Bridge

Import `./codex-bridge` to expose the existing memory harness to Codex-facing code without OpenCode hooks. The bridge exposes:

- `save_memory`
- `search_memories`
- `list_memories`
- `get_context_brief`
- `recall_lessons`
- `prune_memories_dry_run`
- `backfill_missing_embeddings`
- `get_compaction_report`

`get_context_brief` is the primary entry point for a fresh Codex task. It creates or reuses a bridge session for the project root, refreshes context, and returns the compact brief plus relevant lessons and active risks.

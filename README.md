Cross-Session Memory (CSM)

A continuity runtime for AI coding assistants. CSM turns raw events into durable beliefs through a safety-gated pipeline — backed by PostgreSQL + pgvector (default) or SQLite.

Backed by PostgreSQL + pgvector (default) or SQLite (lightweight alternative). 25 tables. 27 runtime tools. 728 tests.

---

## Why CSM?

Large language models are exceptionally capable, but every session begins with the same limitation: their working memory is temporary.

As projects grow, conversations become longer, tools generate thousands of lines of output, and important decisions disappear behind an ever-expanding context window.

CSM addresses this by separating **long-term continuity** from the model's limited working context.

Instead of treating every conversation as isolated, the engine continuously builds a structured knowledge base of your project, allowing AI systems to maintain continuity across sessions, conversations, and development cycles.

---

## What CSM Does

CSM gives an AI assistant long-term continuity. Without it, every session starts from zero. With it, the assistant remembers decisions, learns from mistakes, tracks its own capabilities, and maintains a living model of what it knows and doesn't know.

The key insight: **memory alone isn't continuity.** CSM is a pipeline — raw events flow through compaction, experience packets, candidate scanning, belief promotion, and advisory injection. Each stage has safety gates. Nothing gets promoted to durable memory without passing confidence thresholds, dedup checks, and contradiction detection.

### Persistent Memory

Important information survives beyond a single conversation. The engine stores meaningful knowledge instead of forcing the model to relearn the same information every session.

### Intelligent Context Retrieval

Only relevant memories are brought back into context. Rather than injecting an entire history, CSM performs semantic retrieval to provide only the information needed for the current task.

### Context Compaction

Long conversations become efficient. Instead of keeping every tool call and every message forever, the engine intelligently compresses historical context into concise summaries while preserving the important information.

### Agent Journaling

Every significant action can be recorded as structured knowledge. The system maintains an evolving record of work completed, architectural decisions, discoveries, failures, and successes.

### Lessons Learned

Mistakes become permanent improvements. When an issue is solved once, the lesson can be preserved so future sessions avoid repeating the same problem.

### Project Knowledge

The engine builds an understanding of your project over time. Architecture decisions, repository knowledge, workflows, documentation, and development history become searchable knowledge instead of disappearing into old conversations.

### Checkpoints

Major milestones can be saved and restored. Instead of relying on enormous conversation histories, AI systems can return to meaningful checkpoints with the necessary context already assembled.

### Context Pressure Management

The engine monitors context usage before it becomes a problem. As conversations grow, CSM manages information intelligently to help keep working context focused and efficient.

---

## The Pipeline

```
raw events
  → work journal (tool calls, decisions, errors)
    → compaction (token-budgeted compression, 90.8% reduction)
      → experience packets (structured observations + internal state)
        → candidate scanning (pattern detection, belief extraction)
          → belief promotion (confidence-gated, dedup-checked)
            → durable memories (provenance-tracked)
              → advisory living state (context brief injection)
```

Each stage is optional. The pipeline degrades gracefully — use only what you need.

### Stage 1: Work Journal
Real-time capture of tool calls, decisions, and session boundaries.

### Stage 2: Compaction
Token-budgeted context compression. Replaces raw tool output with distilled references. 2B+ tokens saved.

### Stage 3: Experience Packets
Structured observations from tool executions, errors, milestones, and session events. Carries internal state (frustration, energy, stance, urgency) from 10 pure derivation functions.

### Stage 4: Candidate Scanning
Reads experience packets, groups by pattern fingerprints, maps to 5 candidate types: belief, preference, worldview, drift warning, opinion. Confidence formula with contradiction penalty.

### Stage 5: Belief Promotion
Conservative engine. Promotes candidates to durable memories only when thresholds pass: min confidence (0.7), min reinforcement (3), min evidence refs (2). Dedup-checked. Contradiction-gated. Provenance metadata on every promoted memory.

### Stage 6: Advisory Living State
Assembles an advisory block for the context brief: recent experience, candidate deltas, self-model state, belief knowledge. Labeled "preview, not durable truth."

---

## Safety Model

- **Preview vs durable truth** — Advisory blocks are labeled previews. No behavior changes without explicit enablement.
- **Dry-run by default** — All maintenance tools default to dry-run. Nothing mutates without explicit action.
- **Provenance tracking** — Every promoted memory carries source refs, evidence sessions, confidence, and promotion timestamps.
- **Threshold profiles** — Production defaults (conf=0.7, rein=3, evid=2) vs relaxed mode (conf=0.3, rein=1, evid=1) for development.
- **Dedup on insert** — Exact content dedup prevents duplicate memories. Partial unique index on candidate queue.
- **Contradiction detection** — Candidates with contradicted_count > 0 are flagged `needs_review`, never auto-promoted.
- **Budget trimming** — Advisory block respects token budget. Drop order: beliefs → capabilities → signals.

## Tools

---

## Tool Groups

### Memory (10 tools)
| Tool | Description |
|------|-------------|
| `csm_memory_save` | Save a durable memory |
| `csm_memory_search` | Semantic search across memories |
| `csm_memory_list` | List memories with type/tag/date filters |
| `csm_memory_delete` | Delete a memory by ID |
| `csm_memory_context` | Get current session context brief |
| `csm_memory_lesson` | Save a lesson learned (high importance) |
| `csm_memory_transcript` | Get conversation transcript |
| `csm_memory_distill` | Distill tool-call activity into summaries |
| `csm_memory_distilled_view` | View recent distilled summaries |
| `csm_memory_compact` | Report on compaction savings |

### Governance (6)
| Tool | Description |
|------|-------------|
| `csm_memory_candidate_generate` | Generate maintenance candidates (dry-run) |
| `csm_memory_candidate_report` | Show candidate counts by type/status |
| `csm_memory_backfill_embeddings` | Repair missing embeddings |
| `csm_memory_dedup_detect` | Find duplicate memory clusters |
| `csm_memory_merge` | Merge exact content duplicates (dry-run) |
| `csm_memory_archive_candidate_report` | Archive-candidate report |

### Beliefs (5)
| Tool | Description |
|------|-------------|
| `csm_belief_scan` | Scan experience packets for recurring patterns |
| `csm_belief_scan_report` | Show belief candidate counts |
| `csm_belief_promote` | Promote candidates to durable memories |
| `csm_belief_knowledge` | View consolidated belief knowledge |
| `csm_memory_governance_report` | Governance status with invariant checks |

### Self-Model (1)
| Tool | Description |
|------|-------------|
| `csm_self_model` | Capability confidence scores and drift warnings |

### Living State (2)
| Tool | Description |
|------|-------------|
| `csm_living_state_preview` | Preview advisory pipeline output |
| `csm_living_state_debug` | Diagnose advisory block assembly |

### Experience (1)
| Tool | Description |
|------|-------------|
| `csm_memory_packets` | List recent experience packets with internal state |

### Diagnostics (2)
| Tool | Description |
|------|-------------|
| `csm_runtime_status` | Plugin health, DB connectivity, tool registry |
| `csm_compaction_audit` | Audit compaction telemetry |

---

## Database Architecture

25 tables across 7 subsystems:

### Core (4)
`sessions`, `memories`, `memory_chunks`, `memory_merges`

### Candidates (1)
`memory_candidate_queue` — 10 candidate types (5 maintenance + 5 belief). Partial unique indexes.

### Living State (4)
`experience_packets`, `belief_knowledge_store`, `self_model_capabilities`, `self_continuity_records`

### Session (3)
`memory_events`, `session_contexts`, `project_scopes`

### Infrastructure (7)
`checkpoints`, `checkpoint_raw_captures`, `context_cache`, `context_compilation_log`, `context_rollover`, `goals`, `agent_work_journal`

### Cross-Session (2)
`cross_session_causal_links`, `memory_recall_events`

### Quality (1)
`memory_quality_scores` — Per-memory scoring with band and feature tracking

### Key Indexes
HNSW on `memory_chunks` (vector similarity). GIN on `memories` (tags, search_vector). Partial unique on candidate queue and distilled summaries. Active checkpoint lookup.

---

## Metrics

| Variable | Default | Description |
|----------|---------|-------------|
| `CSM_DATABASE_PROVIDER` | `postgres` | `postgres` or `sqlite` |
| `CSM_DATABASE_URL` | — | PostgreSQL connection string |
| `CSM_SQLITE_PATH` | `./csm.db` | SQLite file path |
| `CSM_EMBEDDING_PROVIDER` | `ollama` | `ollama` or `openai` |
| `EMBEDDING_DIMENSIONS` | `1536` | Vector dimension (768 for nomic-embed-text) |
| `EMBEDDING_API_URL` | — | Embedding API endpoint |
| `EMBEDDING_API_KEY` | — | Embedding API key |
| `EMBEDDING_MODEL` | — | Embedding model name |
| `CSM_BELIEF_PROMOTION_ENABLED` | `false` | Enable live belief promotion |
| `CSM_BELIEF_PROMOTION_RELAXED` | `false` | Relaxed thresholds (dev only) |
| `CSM_LIVING_STATE_INJECT_ADVISORY` | `false` | Inject advisory block into context |

---

## Quick Start

```bash
npm install
npm run build
npm run verify
```

### PostgreSQL (default)
```bash
# Set in .env or export:
export CSM_DATABASE_URL=postgresql://user:pass@localhost:5432/csm
npm run verify
```

### SQLite
```bash
export CSM_DATABASE_PROVIDER=sqlite
export CSM_SQLITE_PATH=./csm.db
npm run verify
```

---

## Codex Bridge

## Metrics

---

## Benefits

Using CSM allows AI systems to:

- Remember important information across sessions
- Dramatically reduce unnecessary token usage
- Maintain long-running software projects
- Preserve architectural decisions
- Reduce repeated explanations
- Improve consistency between sessions
- Retrieve relevant knowledge in seconds
- Scale to projects that would otherwise exceed model context limits

---

## Roadmap

### ClaudeX — Database UI (Next Phase)

ClaudeX is the planned conversational interface for CSM's database layer. Instead of pgAdmin or DBeaver, you chat with your data:

- **Lens system** — Personal, Work, Code, Research, Creative contexts
- **Memory recall** — Surfaces relevant memories based on conversation context
- **Advisory injection** — Living state block shows what the system knows/doesn't know
- **Provenance transparency** — Every memory shows its source, confidence, and evidence

ClaudeX already runs against CSM's Postgres backend with 39K+ memories. The lens blend system biases context toward the active domain. The next phase is building the database management layer — schema exploration, query assistance, migration planning — all through conversation.

---

## Architecture Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Module flow and dependency map
- [docs/PHASE3G_SQLITE_MVP.md](docs/PHASE3G_SQLITE_MVP.md) — SQLite adapter documentation
- [docs/PHASE4FA_LIVING_STATE_PREVIEW.md](docs/PHASE4FA_LIVING_STATE_PREVIEW.md) — Living state pipeline
- [docs/PHASE4FC_STAGED_ENABLEMENT.md](docs/PHASE4FC_STAGED_ENABLEMENT.md) — Advisory block staging
- [docs/PHASE4EB_BELIEF_KNOWLEDGE_CONTRACT.md](docs/PHASE4EB_BELIEF_KNOWLEDGE_CONTRACT.md) — Belief knowledge contract
- [docs/PHASE4B5_PACKET_CONTRACT.md](docs/PHASE4B5_PACKET_CONTRACT.md) — Experience packet vocabulary

## Roadmap

### ClaudeX — Database UI (Next Phase)

CSM is built around a simple idea:

> Intelligence is amplified by continuity.

Models are already excellent at reasoning. What they lack is persistent experience.

CSM provides the missing layer between temporary reasoning and long-term knowledge, allowing AI systems to build on previous work instead of constantly starting over.

---

**CSM isn't another chatbot memory feature.**

It is a persistence and continuity platform designed to give AI systems a durable understanding of the work they've already done, enabling longer-lived, more capable, and more efficient assistants.

---

## Key Design Decisions

- **Pipeline over storage** — CSM is a processing system, not a database wrapper. Every stage adds value.
- **Safety by default** — Dry-run first, preview labels, conservative thresholds. Nothing promotes without gates.
- **Provenance required** — Every memory traces back to source events. No orphaned knowledge.
- **Graceful degradation** — SQLite works. Vector search falls back to text. Advisory blocks are opt-in.
- **No raw telemetry** — Recall events store hashed queries only. No user text in audit trails.



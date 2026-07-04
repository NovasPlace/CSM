 Cross-Session Memory (CSM)

A continuity runtime for AI coding assistants. Not just memory — a full pipeline that turns raw events into durable beliefs, with safety gates at every stage.

Backed by PostgreSQL + pgvector (default) or SQLite (lightweight alternative). 25 tables. 23 runtime tools. 728 tests.

## What CSM Is

CSM gives an AI assistant long-term continuity. Without it, every session starts from zero. With it, the assistant remembers decisions, learns from mistakes, tracks its own capabilities, and maintains a living model of what it knows and doesn't know.

The key insight: memory alone isn't continuity. CSM is a **pipeline** — raw events flow through compaction, experience packets, candidate scanning, belief promotion, and advisory injection. Each stage has safety gates. Nothing gets promoted to durable memory without passing confidence thresholds, dedup checks, and contradiction detection.

## The Pipeline

```
raw events
  → work journal (tool calls, decisions, errors)
    → compaction (token-budgeted compression, 81.9% avg savings)
      → experience packets (structured observations with internal state)
        → candidate scanning (pattern detection, belief extraction)
          → belief promotion (confidence-gated, dedup-checked)
            → durable memories (provenance-tracked, auditable)
              → advisory living state (context brief injection)
```

Each stage is optional. The pipeline degrades gracefully — if you only use memory save/search, everything downstream is inert.

### Stage 1: Work Journal
Every tool call, decision, and session boundary is captured in real time. The journal is the raw material for everything downstream.

### Stage 2: Compaction
Context compression replaces raw tool output with distilled references. Status-tracked: `compressed`, `skipped_under_budget`, `failed`. 2B+ tokens saved globally across 10K+ compactions.

### Stage 3: Experience Packets
Structured observations derived from tool executions, errors, milestones, and session events. Each packet carries internal state (frustration, energy, stance, urgency) derived from 10 pure functions.

### Stage 4: Candidate Scanning
The belief promotion scanner reads experience packets, groups by pattern fingerprints, and maps to candidate types: belief, preference, worldview, drift warning, opinion. Confidence formula with contradiction penalty.

### Stage 5: Belief Promotion
Conservative promotion engine. Only high-confidence, well-evidenced candidates become durable memories. Gates: min confidence (0.7), min reinforcement (3), min evidence refs (2), dedup, contradiction check. Provenance metadata on every promoted memory.

### Stage 6: Advisory Living State
The living state advisor assembles an advisory block for the context brief. Shows recent experience, candidate deltas, self-model state, and belief knowledge. Labeled "preview, not durable truth" — never imperative, never absolutist.

## Safety Model

Every stage has guards:

- **Preview vs durable truth** — Advisory blocks are labeled as previews. No behavior changes until explicitly enabled.
- **Dry-run first** — All maintenance tools default to dry-run. Nothing mutates without explicit action.
- **Provenance tracking** — Every promoted memory carries source refs, evidence sessions, confidence scores, and promotion timestamps.
- **Threshold profiles** — Production defaults (conf=0.7, rein=3, evid=2) vs relaxed mode (conf=0.3, rein=1, evid=1). Relaxed mode requires explicit flag.
- **Dedup before insert** — Exact content dedup prevents duplicate memories. Partial unique index on candidate queue.
- **Contradiction detection** — Candidates with contradicted_count > 0 are flagged `needs_review`, not auto-promoted.
- **Budget trimming** — Advisory block respects token budget. Preserves warnings longest: beliefs → capabilities → signals dropped first.

## Tool Groups

### Memory (10 tools)
| Tool | Description |
|------|-------------|
| `csm_memory_save` | Save information to cross-session memory |
| `csm_memory_search` | Semantic search across memories |
| `csm_memory_list` | List memories with filters |
| `csm_memory_delete` | Delete a memory by ID |
| `csm_memory_context` | Get current session context brief |
| `csm_memory_lesson` | Save a lesson learned from mistakes |
| `csm_memory_transcript` | Get conversation transcript |
| `csm_memory_distill` | Distill tool-call activity into summaries |
| `csm_memory_distilled_view` | View distilled summaries |
| `csm_memory_compact` | Report on compaction savings |

### Candidates & Governance (3 tools)
| Tool | Description |
|------|-------------|
| `csm_memory_candidate_generate` | Generate maintenance candidates (advisory, dry-run) |
| `csm_memory_candidate_report` | Show candidate counts by type/status |
| `csm_memory_backfill_embeddings` | Repair missing embeddings |

### Experience Packets (1 tool)
| Tool | Description |
|------|-------------|
| `csm_memory_packets` | List recent experience packets with internal state |

### Beliefs (4 tools)
| Tool | Description |
|------|-------------|
| `csm_belief_scan` | Scan packets for recurring patterns |
| `csm_belief_scan_report` | Show belief candidate counts |
| `csm_belief_promote` | Promote candidates to durable memories |
| `csm_belief_knowledge` | View consolidated belief knowledge |

### Self-Model (1 tool)
| Tool | Description |
|------|-------------|
| `csm_self_model` | View capability confidence scores and drift warnings |

### Living State (2 tools)
| Tool | Description |
|------|-------------|
| `csm_living_state_preview` | Preview advisory pipeline output |
| `csm_living_state_debug` | Diagnose advisory block assembly |

### Diagnostics (2 tools)
| Tool | Description |
|------|-------------|
| `csm_runtime_status` | Plugin status, DB connectivity, tool registry |
| `csm_compaction_audit` | Audit compaction telemetry for correctness |

## Database Architecture

25 tables across 7 schema subsystems:

### Core (4 tables)
- `distilled_summaries` — Compressed tool-call activity with dedup index
- `compaction_metrics` — Per-compaction stats with status tracking (`compressed | skipped_under_budget | failed`)
- `memory_candidates` — Reviewable memory candidates from extractor
- `project_scopes` — Project isolation boundaries

### Memory (3 tables)
- `memories` — The main memory store. 11 types: conversation, workspace, repo, preference, lesson, episodic, procedural, concept, code, config, error, self_continuity
- `memory_chunks` — Chunked embeddings for long memories
- `memory_merges` — Audit trail for dedup merges

### Session (3 tables)
- `sessions` — OpenCode session records
- `memory_events` — Event bus for memory operations
- `session_contexts` — Cached context briefs

### Candidates (1 table)
- `memory_candidate_queue` — Unified queue for 10 candidate types (5 maintenance + 5 belief). Partial unique indexes for dedup.

### Living State (4 tables)
- `experience_packets` — Structured observations with internal state
- `belief_knowledge_store` — Consolidated preferences, opinions, worldviews
- `self_model_capabilities` — Per-capability confidence scores with evidence refs
- `self_continuity_records` — Cross-session identity tracking

### Infrastructure (7 tables)
- `checkpoints` — Durable session summaries with raw captures
- `checkpoint_raw_captures` — Recovery store for checkpoint content
- `context_cache` — Session-scoped content for on-demand fetch
- `context_compilation_log` — Per-call compilation stats
- `context_rollover` — Cumulative token tracker
- `goals` — User-declared session objectives
- `agent_work_journal` — Real-time tool call capture

### Cross-Session (2 tables)
- `cross_session_causal_links` — Causal edges between sessions (direct | inferred | gap)
- `memory_recall_events` — Hashed recall telemetry (no raw queries)

### Indexes
Key performance indexes: HNSW on memory_chunks (vector similarity), GIN on memories (tags, search_vector), partial unique on candidate queue (dedup), partial unique on distilled_summaries (dedup), active checkpoint lookup.

## Metrics

| Metric | Value |
|--------|-------|
| Test suite | 728/728 passing |
| Runtime tools | 23 (`csm_` namespace) |
| Database tables | 25 |
| Memory types | 11 |
| Candidate types | 10 (5 maintenance + 5 belief) |
| Global tokens saved | 2.02B+ |
| Compaction rate | 81.9% average savings |
| Live memories | 46,000+ |
| Embeddings | 7,500+ |
| Lint baseline | 102 warnings (max-warnings=102) |

## Quick Start

```bash
npm install
npm run build
npm run verify
```

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CSM_DATABASE_PROVIDER` | `postgres` | `postgres` or `sqlite` |
| `CSM_SQLITE_PATH` | `./csm.db` | SQLite file path |
| `CSM_EMBEDDING_PROVIDER` | `ollama` | `ollama` or `openai` |
| `CSM_BELIEF_PROMOTION_ENABLED` | `false` | Enable live belief promotion |
| `CSM_BELIEF_PROMOTION_RELAXED` | `false` | Relaxed thresholds (dev only) |
| `CSM_LIVING_STATE_INJECT_ADVISORY` | `false` | Inject advisory block into context |

### SQLite Mode

```bash
$env:CSM_DATABASE_PROVIDER = "sqlite"
$env:CSM_SQLITE_PATH = "./csm.db"
npm run verify
```

Degraded: no vector ANN, no embedding index, text search fallback. All CRUD works. 26 contract tests pass on both backends.

## Codex Bridge

Import `./codex-bridge` to expose the memory harness to Codex-facing code. 49 bridge tools including memory CRUD, context compilation, checkpoints, governance, and goal tracking.

## Architecture Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Module flow and dependency map
- [docs/PHASE3G_SQLITE_MVP.md](docs/PHASE3G_SQLITE_MVP.md) — SQLite adapter documentation
- [docs/PHASE4FA_LIVING_STATE_PREVIEW.md](docs/PHASE4FA_LIVING_STATE_PREVIEW.md) — Living state pipeline
- [docs/PHASE4FC_STAGED_ENABLEMENT.md](docs/PHASE4FC_STAGED_ENABLEMENT.md) — Advisory block staging
- [docs/PHASE4EB_BELIEF_KNOWLEDGE_CONTRACT.md](docs/PHASE4EB_BELIEF_KNOWLEDGE_CONTRACT.md) — Belief knowledge contract
- [docs/PHASE4B5_PACKET_CONTRACT.md](docs/PHASE4B5_PACKET_CONTRACT.md) — Experience packet vocabulary

## Future Direction

### ClaudeX — Database UI

ClaudeX is the planned conversational interface for CSM's database layer. Instead of pgAdmin or DBeaver, you chat with your data:

- **Lens system** — Personal, Work, Code, Research, Creative contexts
- **Memory recall** — Surfaces relevant memories based on conversation context
- **Advisory injection** — Living state block shows what the system knows/doesn't know
- **Provenance transparency** — Every memory shows its source, confidence, and evidence

ClaudeX already runs against CSM's Postgres backend with 39K+ memories. The lens blend system biases context toward the active domain. The next phase is building the database management layer — schema exploration, query assistance, migration planning — all through conversation.

## Key Design Decisions

- **Pipeline over storage** — CSM is a processing system, not a database wrapper. Every stage adds value.
- **Safety by default** — Dry-run first, preview labels, conservative thresholds. Nothing promotes without gates.
- **Provenance required** — Every memory traces back to source events. No orphaned knowledge.
- **Graceful degradation** — SQLite works. Vector search falls back to text. Advisory blocks are opt-in.
- **No raw telemetry** — Recall events store hashed queries only. No user text in audit trails.



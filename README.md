<div align="center">

# CSM

### Your AI coding assistant never forgets.

**Cross-Session Memory for [opencode](https://github.com/anomalyco/opencode).**

[![Tests](https://img.shields.io/badge/tests-918-brightgreen)]()
[![Lint](https://img.shields.io/badge/lint-0%20errors-blue)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)]()
[![Node](https://img.shields.io/badge/node-20%2B-green)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)]()

</div>

---

Every time you start a new session, your AI starts from scratch. It doesn't remember your project. It doesn't remember what you decided. It makes the same mistakes.

**CSM fixes this.**

It gives your assistant a durable memory layer — preferences, lessons, decisions, capability tracking, and a living state model that persists across every conversation. When you start a new session, your agent picks up right where you left off. Not "Hi, how can I help?" — but *"Resuming the CSM project, Phase 9A-Tune. Last session you fixed the re-entry session ID bug. Open thread: smart trimming."*

---

## What it does

| Feature | What it means |
|---------|--------------|
| **Persistent Memory** | Preferences, lessons, decisions, and procedural knowledge survive across sessions. 56,000+ memories in production. |
| **Re-Entry Context** | Every new session starts with an 8-layer context block: identity, preferences, capabilities, beliefs, constraints, active goals, work journal, and handoff state. Your agent resumes, not restarts. |
| **Agent Onboarding** | Constitutional identity (Prime Directive, hardwired instincts), project continuity, and readiness summary injected before the first token. |
| **Living State** | Real-time self-model tracks capability confidence with diminishing returns. Belief system consolidates patterns from experience packets. Advisory context brief keeps the agent honest about what it knows vs. what it's guessing. |
| **Memory Governance** | Dedup detection (exact + embedding ANN), safe merge (supersede, never delete), archive (7,300+ entries archived), quality scoring, and candidate-driven maintenance. |
| **Compaction** | Long tool outputs are distilled to references. 90%+ token savings. 2B+ tokens compacted in production. |
| **Dual Backend** | PostgreSQL + pgvector for full vector search. SQLite for zero-dependency mode. Same API, same tests, same behavior. |

---

## Quick Start

```bash
git clone https://github.com/NovasPlace/CSM.git
cd CSM
npm install
npm run build
npm run verify    # 918 tests
```

### PostgreSQL (recommended)

```bash
# Install pgvector
CREATE EXTENSION vector;

# Point CSM at your database
export DATABASE_URL=postgresql://user:pass@localhost:5432/csm

# Done.
npm run verify
```

### SQLite (zero dependencies)

```bash
export CSM_DATABASE_PROVIDER=sqlite
export CSM_SQLITE_PATH=./csm.db
npm run verify
```

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/cross_session_memory` | PostgreSQL connection string |
| `CSM_DATABASE_PROVIDER` | `postgres` | `postgres` or `sqlite` |
| `CSM_SQLITE_PATH` | `./csm.db` | SQLite database file path |
| `EMBEDDING_PROVIDER` | `ollama` | `ollama` or `openai` |
| `EMBEDDING_API_URL` | `http://localhost:11434/v1` | Embedding API endpoint |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model name |
| `EMBEDDING_DIMENSIONS` | `768` | Vector dimensions |
| `CSM_REENTRY_PREVIEW_ONLY` | `false` | Set `true` to test re-entry without live injection |
| `CSM_SELF_MODEL_CONFIDENCE_RATE` | `10` | Confidence increment rate (%) — diminishing returns after 20 evidence points |

---

## Tool Surface — 33 Tools

| Category | Tools | What they do |
|----------|-------|-------------|
| **Memory** | `save`, `search`, `list`, `delete`, `context`, `lesson`, `transcript`, `distill`, `distilled_view`, `compact`, `related` | Store, find, and manage memories across sessions |
| **Governance** | `backfill_embeddings`, `dedup_detect`, `merge`, `candidate_generate`, `candidate_report`, `archive_candidate_report`, `governance_report` | Keep the memory store clean, deduped, and archived |
| **Beliefs** | `belief_scan`, `belief_scan_report`, `belief_promote`, `belief_knowledge`, `belief_promotion_scan` | Extract recurring patterns into durable beliefs with confidence scoring |
| **Living State** | `living_state_preview`, `living_state_debug` | Real-time view of self-model, beliefs, and advisory context |
| **Self-Model** | `self_model` | Capability confidence, drift warnings, evidence counts |
| **Continuity** | `reentry_preview`, `onboard_agent`, `memory_context` | Re-entry context builder, agent onboarding startup packet, session context |
| **Experience** | `packets` | Browse the structured observation log (tool calls, errors, decisions, milestones) |
| **Diagnostics** | `runtime_status`, `compaction_audit`, `recall_quality_report`, `continuity_report` | Health checks, performance audits, recall quality scoring |

---

## How It Works

```
Session starts
    │
    ▼
┌──────────────────────────────────┐
│  AGENT ONBOARDING (first turn)   │  Constitutional identity + project continuity
│  RE-ENTRY CONTEXT (first turn)   │  8-layer context block injected to system prompt
└──────────┬───────────────────────┘
           │
    ▼  ┌──────────────┐
       │  USER WORKS  │
    ▲  └──────┬───────┘
           │
    ┌──────▼───────────────────────────────┐
    │  CAPTURE                              │
    │  Tool calls, errors, decisions        │
    │  → experience packets                 │
    └──────┬───────────────────────────────┘
           │
    ┌──────▼───────────────────────────────┐
    │  COMPRESS                             │
    │  Long outputs → distilled references  │
    │  90%+ token savings                   │
    └──────┬───────────────────────────────┘
           │
    ┌──────▼───────────────────────────────┐
    │  OBSERVE → SCAN → PROMOTE             │
    │  Packets → patterns → candidates      │
    │  → beliefs → self-model               │
    │  Quality gates at every stage         │
    └──────┬───────────────────────────────┘
           │
    ┌──────▼───────────────────────────────┐
    │  ADVISE                               │
    │  Advisory context brief:              │
    │  "Here's what I know, here's what     │
    │   I'm uncertain about."               │
    └──────────────────────────────────────┘
```

Every promotion has safety gates: confidence thresholds, dedup checks, contradiction detection, and diminishing returns on capability confidence. Nothing gets saved without evidence.

---

## By the Numbers

| Metric | Value |
|--------|-------|
| Tests | 918/918 |
| Tools | 33 |
| Database tables | 24+ |
| Active memories (production) | 56,000+ |
| Tokens compacted | 2B+ |
| Compaction rate | 90.8% |
| Lint warnings | 7 (all in external API types) |
| Lint errors | 0 |

---

## Architecture

- **TypeScript** throughout — strict mode, ESLint v9 flat config
- **PostgreSQL + pgvector** — full-text search, ANN vector search, hybrid search
- **SQLite** — zero-dependency adapter, text search fallback for vector queries
- **Node 20+** — ESM modules, no CommonJS
- **Plugin architecture** — hooks for `system.transform`, `tool.execute`, `chat.message`, `chat.prompt`, `session.start`, `session.end`, and more

### Key modules

| Module | Responsibility |
|--------|---------------|
| `memory-manager.ts` | CRUD, search, metadata, pagination |
| `re-entry-protocol.ts` | 8-layer context block builder with priority trimming |
| `agent-onboarding.ts` | 10-provider startup packet orchestrator |
| `hybrid-search.ts` | Vector + text + entity boost with dialect-aware filters |
| `belief-knowledge-store.ts` | Belief consolidation with junk filtering and quality gates |
| `self-model-updater.ts` | Capability tracking with diminishing returns |
| `context-compiler.ts` | Token budget management and context brief generation |
| `tool-distiller.ts` | Structured tool-call grouping with fix description extraction |
| `experience-packet.ts` | Event capture with internal state derivation |

---

## Deeper Reading

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Module flow and dependencies
- [docs/PHASE3G_SQLITE_MVP.md](docs/PHASE3G_SQLITE_MVP.md) — SQLite adapter design
- [docs/PHASE4FC_STAGED_ENABLEMENT.md](docs/PHASE4FC_STAGED_ENABLEMENT.md) — Living state advisory pipeline
- [docs/PHASE7C_REENTRY_PROTOCOL_DOCUMENTATION.md](docs/PHASE7C_REENTRY_PROTOCOL_DOCUMENTATION.md) — Re-entry context builder
- [docs/PHASE9A_TUNE_TASKLIST.md](docs/PHASE9A_TUNE_TASKLIST.md) — Onboarding continuity tuning

---

## Contributing

PRs welcome. Run these before pushing — all must pass:

```bash
npm run build       # TypeScript compilation
npm run typecheck   # Type checking (no emit)
npm run lint:src    # ESLint (0 errors, 7 warnings max)
npm test            # 918 tests
```

---

<div align="center">

**Built with TypeScript. Runs on Node 20+. Licensed MIT.**

[Report a bug](https://github.com/NovasPlace/CSM/issues) · [Request a feature](https://github.com/NovasPlace/CSM/issues) · [Read the docs](docs/)

</div>

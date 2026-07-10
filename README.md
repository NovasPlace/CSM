<div align="center">

# CSM

### Your AI coding assistant never forgets.

**Cross-Session Memory for [opencode](https://github.com/anomalyco/opencode).**

[![Tests](https://img.shields.io/badge/tests-969-brightgreen)]()
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
| **Dual Backend** | PostgreSQL + pgvector for the full runtime. SQLite provides a zero-dependency core-memory mode with text-search fallback; PostgreSQL-only services are explicitly unavailable. |

---

## Quick Start

```bash
git clone https://github.com/NovasPlace/CSM.git
cd CSM
npm install
npm run build
npm run verify    # 969 tests
```

### PostgreSQL (recommended)

```bash
# Install pgvector
CREATE EXTENSION vector;

# Point CSM at your database
export CSM_DATABASE_URL=postgresql://user:pass@localhost:5432/csm

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
| `CSM_DATABASE_URL` | `postgresql://localhost:5432/opencode_memory` | PostgreSQL connection string |
| `CSM_DATABASE_PROVIDER` | `postgres` | `postgres` or `sqlite` |
| `CSM_SQLITE_PATH` | `.data/csm-memory.db` | SQLite database file path |
| `CSM_DB_POOL_MAX` | `20` | PostgreSQL connection-pool limit |
| `CSM_DB_CONNECTION_TIMEOUT_MS` | `5000` | PostgreSQL connection timeout |
| `CSM_DB_STATEMENT_TIMEOUT_MS` | `0` | Per-statement timeout; `0` disables it |
| `CSM_DB_IDLE_TIMEOUT_MS` | `30000` | Idle pooled-connection timeout |
| `CSM_DB_TLS_MODE` | `url` | `url`, `disable`, `require`, or `verify-full` |
| `CSM_WORK_LEDGER_ENABLED` | `true` | Capture PostgreSQL run-level file provenance |
| `CSM_WORK_LEDGER_MAX_FILE_BYTES` | `5000000` | Maximum file size captured by before/after hashing |
| `CSM_RUN_ID` | generated UUID | Optional orchestrator-supplied run identity |
| `CSM_MODEL_ID` | host-reported | Optional pinned `provider:model` identity |
| `CSM_EMBEDDING_PROVIDER` | `ollama` | `ollama` or `openai` |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama service URL |
| `OPENAI_API_KEY` | unset | Required when the embedding provider is `openai` |
| `CSM_REENTRY_PREVIEW_ONLY` | `false` | Set `true` to test re-entry without live injection |
| `CSM_SELF_MODEL_CONFIDENCE_RATE` | `10` | Confidence increment rate (%) — diminishing returns after 20 evidence points |

---

## Tool Surface — 34 Tools

This table describes the full PostgreSQL surface. SQLite intentionally exposes a smaller core-memory surface and rejects PostgreSQL-only governance, vector, and living-state operations with explicit capability errors.

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
| **Work Ledger** | `work_ledger_surviving` | Recompute and report run-owned changes that still survive |

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
| Tests | 969/969 |
| Tools | 34 |
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
- [docs/ENTERPRISE_READINESS.md](docs/ENTERPRISE_READINESS.md) — Proven baseline, open production gates, and milestone order
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
npm test            # 969 tests
```

---

<div align="center">

**Built with TypeScript. Runs on Node 20+. Licensed MIT.**

[Report a bug](https://github.com/NovasPlace/CSM/issues) · [Request a feature](https://github.com/NovasPlace/CSM/issues) · [Read the docs](docs/)

</div>

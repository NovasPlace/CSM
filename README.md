# CSM — Cross-Session Memory

**Give your AI assistant long-term memory.**

CSM is a plugin that lets AI coding assistants remember across sessions. It stores what they learn — your preferences, your project structure, the mistakes they've fixed, the decisions you've made. Every time you start a new session, they pick up right where you left off.

It's PostgreSQL-backed (with optional SQLite), runs locally, and takes 2 minutes to set up.

---

## Why use it?

Your AI assistant forgets everything at the end of each session. That sucks. You have to repeat yourself. It makes the same mistakes twice. It doesn't remember what you decided last time.

CSM fixes this. It gives your assistant a durable memory that persists across sessions, workspaces, and conversations. It learns from experience and gets better over time.

---

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/NovasPlace/CSM.git
cd CSM
npm install

# 2. Build
npm run build

# 3. Run the tests (requires PostgreSQL running locally)
npm run verify
```

That's it. 731 tests will run against a local Postgres instance.

---

## Configuration

Create a `.env` file or set these as environment variables:

| Variable | Default | What it does |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/cross_session_memory` | Database connection |
| `CSM_DATABASE_PROVIDER` | `postgres` | Use `sqlite` for zero-dependency mode |
| `EMBEDDING_PROVIDER` | `ollama` | `ollama` or `openai` |
| `EMBEDDING_API_URL` | `http://localhost:11434/v1` | Embedding API endpoint |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Model used for vector search |
| `EMBEDDING_DIMENSIONS` | `1536` | Vector dimensions (set to 768 for `nomic-embed-text`) |
| `EMBEDDING_API_KEY` | `ollama` | API key for embedding provider |

### PostgreSQL (recommended)

PostgreSQL + pgvector gives you full vector search, ANN indexes, and all features.

```bash
# Install pgvector extension in your Postgres DB:
CREATE EXTENSION vector;

# Set your connection:
export DATABASE_URL=postgresql://user:pass@localhost:5432/csm

# Run!
npm run verify
```

### SQLite (lightweight)

Want zero dependencies? Use SQLite. No Postgres needed, no pgvector. Vector search degrades to text search — everything else works.

```bash
export CSM_DATABASE_PROVIDER=sqlite
export CSM_SQLITE_PATH=./csm.db
npm run verify
```

---

## What it can do

CSM gives your assistant **27 tools** organized by category:

| Category | Tools | Description |
|----------|-------|-------------|
| **Memory** | save, search, list, delete, context, lesson, transcript, distill, distilled_view, compact | Store, find, and manage memories |
| **Governance** | candidate_generate, candidate_report, backfill_embeddings, dedup_detect, merge, archive_candidate_report | Keep the memory store clean and healthy |
| **Beliefs** | belief_scan, belief_scan_report, belief_promote, belief_knowledge, governance_report | Extract patterns, build durable knowledge |
| **Living state** | living_state_preview, living_state_debug | See what the system knows right now |
| **Self-model** | self_model | Track capability confidence and drift |
| **Experience** | packets | Browse the observation log |
| **Diagnostics** | runtime_status, compaction_audit | Check health and performance |

---

## How it works (the short version)

CSM processes events through a pipeline — each stage builds on the last:

1. **Capture** — Tool calls, decisions, and errors are recorded as they happen
2. **Compress** — Long outputs get distilled to references (saves 90%+ tokens)
3. **Observe** — Events are turned into structured "experience packets"
4. **Scan** — Recurring patterns across packets become belief candidates
5. **Promote** — High-confidence candidates become durable memories
6. **Advise** — The living state block tells the assistant what it knows

Every promotion has safety gates: confidence thresholds, dedup checks, contradiction detection. Nothing gets saved without evidence.

---

## Project Status

| Metric | Value |
|--------|-------|
| Tests | 731/731 |
| Tools | 27 |
| Tables | 25 |
| Memory types | 12 |
| Candidate types | 10 |
| Tokens saved | 2B+ |
| Compaction rate | 90.8% |
| Lint | 96 warnings (zero errors) |

Used in production with 46,000+ active memories.

---

## Want to dive deeper?

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Module flow and dependencies
- [docs/PHASE3G_SQLITE_MVP.md](docs/PHASE3G_SQLITE_MVP.md) — SQLite adapter details
- [docs/PHASE4FA_LIVING_STATE_PREVIEW.md](docs/PHASE4FA_LIVING_STATE_PREVIEW.md) — Advisory pipeline

---

## Contributing

This is an active project. PRs are welcome. Run `npm run build && npm run verify && npm run lint:src` before pushing — all three must pass.

---

Built with TypeScript. Runs on Node 20+. Licensed MIT.

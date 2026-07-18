<div align="center">

# Cross-Session Memory

**Continuity infrastructure for AI coding agents**

Persistent memory, operational state, re-entry, context governance, and durable lessons across sessions, projects, and model changes.

<p>
  <a href="https://github.com/NovasPlace/CSM/actions/workflows/ci.yml"><img src="https://github.com/NovasPlace/CSM/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/PostgreSQL-14%20%7C%2016-336791" alt="PostgreSQL 14 and 16">
  <img src="https://img.shields.io/badge/SQLite-core%20mode-6b7280" alt="SQLite core mode">
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178c6" alt="TypeScript 5">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-4b5563" alt="Windows Linux macOS">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/NovasPlace/CSM" alt="License"></a>
</p>

[Quick start](#quick-start) · [Feature map](docs/FEATURES.md) · [Architecture](docs/PRODUCT_ARCHITECTURE.md) · [Documentation](docs/README.md) · [Contributing](CONTRIBUTING.md)

</div>

---

> CSM is not a chat-history dump or a thin vector-store wrapper. It is a continuity runtime that records what happened, retrieves what matters, reconstructs working state, and tells a new agent how to continue safely.

## Why CSM exists

Coding agents are effective inside one context window and unreliable across many of them. Important decisions disappear into old transcripts, project state drifts, mistakes repeat, and every fresh session spends tokens rebuilding a partial understanding of the work.

CSM turns continuity into infrastructure.

| Failure mode | CSM response |
|---|---|
| Fresh-session amnesia | Turn-1 AgentBook state and structured re-entry |
| Long-session context pressure | Compaction, context budgeting, checkpoints, and cached context |
| Repeated mistakes | Durable lessons, experience packets, and failure evidence |
| Weak retrieval | Hybrid vector, full-text, entity, type, tag, and importance signals |
| Unverifiable memory | Provenance, quality scoring, governance reports, and source attribution |
| Project-state drift | Append-only operational events, rolling summaries, and current-state projection |
| Storage lock-in | Full PostgreSQL path plus a local SQLite core mode |

## At a glance

| Surface | Current implementation |
|---|---|
| Runtime tools | Up to **50** registered tool surfaces in the full PostgreSQL path |
| Persistence | PostgreSQL 14/16 and SQLite core mode |
| Verification | More than **1,500 automated tests**, type checking, lint gates, CI matrix, and backup/restore drill |
| Session continuity | AgentBook front page plus layered re-entry and onboarding |
| Recall | Vector, text, entity, relationship, and fallback retrieval paths |
| Internal state | Experience packets, self-model, belief knowledge, and advisory context |
| Governance | Deduplication, merge/supersede, archive candidates, quality reports, and continuity health |
| Host | OpenCode plugin with exported runtime modules for broader integration |

## Capability map

| System | What it provides |
|---|---|
| **Memory engine** | Durable memories, lessons, transcripts, hybrid search, related-memory traversal, distillation, and embedding backfill |
| **AgentBook** | Append-only project events, rolling summaries, explicit rules, current-state projection, and a turn-1 front page |
| **Re-entry and onboarding** | Identity, project state, constraints, goals, checkpoints, relevant memories, advisories, and source-aware injection |
| **Context control** | Token-pressure measurement, compaction, context cache, selective fetch, checkpoints, and recovery surfaces |
| **Living State** | Experience packets, capability confidence, belief candidates, promoted knowledge, and preview/debug tools |
| **Governance** | Recall-quality scoring, provenance checks, duplicate detection, safe merge, archive candidates, and continuity reports |
| **Work continuity** | Goals, checkpoints, decision/error retrieval, work-ledger survival, causal stitching, and session handoff |
| **Auto-documentation** | Project-scoped architecture, decisions, changelog, runbook, system-map, debug, and memory artifacts |
| **Storage layer** | PostgreSQL for the complete feature set; SQLite for a zero-service local core |

The complete subsystem and tool inventory is in [docs/FEATURES.md](docs/FEATURES.md).

## How continuity flows

```mermaid
flowchart LR
    A[OpenCode agent] --> H[Hooks and tool surface]

    H --> AB[AgentBook]
    H --> ME[Memory engine]
    H --> LS[Living State]
    H --> CC[Context control]
    H --> WC[Work continuity]

    AB --> DB[(PostgreSQL or SQLite)]
    ME --> DB
    LS --> DB
    CC --> DB
    WC --> DB

    DB --> RE[Re-entry compiler]
    DB --> RC[Recall and context cache]
    RE --> A
    RC --> A

    AB --> FP[AGENTBOOK_STATE.md]
    FP --> A
```

The architecture is intentionally layered:

- **AgentBook** answers: “What is happening in this project right now?”
- **Memory** answers: “What has been learned across sessions?”
- **Re-entry** answers: “What does this agent need before it acts?”
- **Governance** answers: “Why should this information be trusted?”
- **Context control** answers: “What should remain active, cached, compacted, or fetched later?”

See [docs/PRODUCT_ARCHITECTURE.md](docs/PRODUCT_ARCHITECTURE.md) for the runtime boundaries and data paths.

## Major systems

### AgentBook: operational continuity

AgentBook records meaningful tool and session events in an append-only journal, summarizes them in bounded ranges, projects an authoritative current state, and writes a markdown front page for cold-start recovery.

- Tool events are classified by their actual operation.
- Failures retain error and exit-code evidence.
- File operations retain path evidence.
- Rules support project, session, and global scopes with explicit override behavior.
- `AGENTBOOK_STATE.md` is read at startup through `opencode.json`, before plugin hooks need to run.

### Durable memory and recall

CSM stores conversations, project facts, preferences, lessons, episodic evidence, procedures, and continuity records.

Recall combines:

- vector similarity
- full-text search
- entity boosting
- memory type, tag, and importance filters
- relationship traversal
- text-only and vector-only fallback paths

Maintenance tools support embedding backfill, exact duplicate detection, safe merge/supersede, archive candidates, and governance reporting.

### Re-entry and onboarding

A fresh agent can receive a structured continuity block containing:

- identity and self-continuity
- active project and phase
- current goal and checkpoint
- constraints and operating rules
- relevant memories and decisions
- promoted beliefs and advisories
- handoff state and readiness summary
- source attribution and provenance

The compiler applies priority-aware trimming rather than blindly injecting every available record.

### Context control

CSM treats the context window as a managed resource.

- compaction with audit telemetry
- token-bucket and pressure analysis
- persistent context cache and manifest
- selective file-region, decision, and error retrieval
- checkpoints and checkpoint references
- source-only re-entry guards
- goal-aware system transformation
- causal stitching across sessions

### Living State

The Living State layer records structured experience and derives revisable internal state.

- experience packets for successes, failures, milestones, decisions, and observations
- per-capability confidence with success/failure reconciliation
- belief candidates and evidence-backed knowledge
- controlled promotion into durable memory
- advisory preview and debug surfaces
- explicit preview and enablement gates for higher-risk behavior

### Governance and trust

Memory is useful only when its limits are visible.

CSM includes:

- append-only evidence where history matters
- provenance and source attribution
- direct, inferred, and gap evidence distinctions
- recall-quality scoring
- duplicate and archive-candidate reports
- non-destructive merge/supersede behavior
- continuity resilience reporting
- database migration ledgers
- PostgreSQL matrix verification and backup/restore drills

## Quick start

CSM is currently source-first. Build the repository, configure a storage provider, and load the generated `dist/index.js` entrypoint through your local OpenCode plugin setup.

### 1. Clone and install

```bash
git clone https://github.com/NovasPlace/CSM.git
cd CSM
npm install
```

### 2. Choose a database

<details open>
<summary><strong>PostgreSQL — full feature path</strong></summary>

```bash
export CSM_DATABASE_PROVIDER=postgres
export CSM_DATABASE_URL=postgres://user:password@localhost:5432/csm
npm run db:setup
```

PostgreSQL is the complete runtime path and the path exercised by the PostgreSQL 14/16 CI matrix.

</details>

<details>
<summary><strong>SQLite — local core mode</strong></summary>

```bash
export CSM_DATABASE_PROVIDER=sqlite
export CSM_SQLITE_PATH=.data/csm.sqlite
npm run db:setup
```

SQLite removes PostgreSQL-only tools during registration rather than exposing unsupported behavior.

</details>

### 3. Build

```bash
npm run build
```

The package entrypoint is `dist/index.js`, exported as the default OpenCode plugin.

### 4. Enable turn-1 continuity

Add the generated AgentBook front page to your project instructions:

```json
{
  "instructions": [
    "AGENTS.md",
    "AGENTBOOK_STATE.md"
  ]
}
```

CSM updates `AGENTBOOK_STATE.md` as project activity is captured. OpenCode can then read the current state before a fresh session begins normal tool execution.

### 5. Verify the installation

```bash
npm run typecheck
npm run build
npm run lint:src
npm test
```

For the full PostgreSQL reliability gate:

```bash
npm run verify:enterprise
```

## Database modes

| Capability | PostgreSQL | SQLite |
|---|:---:|:---:|
| Core save, search, list, delete, lessons, and transcripts | Yes | Yes |
| AgentBook events, state, summaries, and rules | Yes | Yes |
| Runtime status and local continuity basics | Yes | Yes |
| Vector backfill and advanced maintenance | Yes | No |
| Belief promotion and Living State analysis | Yes | No |
| Recall-quality and continuity resilience reports | Yes | No |
| Context cache, checkpoints, goals, and advanced review tools | Yes | No |
| Enterprise backup/restore verification | Yes | No |

SQLite is deliberately a smaller local mode. PostgreSQL is the target when the entire continuity stack is required.

## Tool surface

The full PostgreSQL runtime can register up to 50 tools across six groups:

| Group | Count | Examples |
|---|---:|---|
| Memory and governance | 19 | `csm_memory_search`, `csm_memory_lesson`, `csm_memory_merge`, `csm_memory_governance_report` |
| Living State | 8 | `csm_belief_scan`, `csm_belief_promote`, `csm_self_model`, `csm_living_state_preview` |
| AgentBook | 3 | `csm_agentbook_events`, `csm_agentbook_state`, `csm_agentbook_rule` |
| Continuity and runtime | 7 | `csm_onboard_agent`, `csm_reentry_preview`, `csm_continuity_report`, `csm_runtime_status` |
| Checkpoints and goals | 6 | `create_checkpoint`, `expand_checkpoint_ref`, `goal_set`, `goal_list` |
| Context cache and review | 7 | `context_search`, `context_fetch_file_region`, `context_fetch_last_error`, `context_fault` |

Some tools are conditional on provider or runtime state. The exact catalog and availability rules are documented in [docs/FEATURES.md](docs/FEATURES.md).

## Configuration

Core environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `CSM_DATABASE_PROVIDER` | `postgres` | Select `postgres` or `sqlite` |
| `CSM_DATABASE_URL` | `postgres://localhost/csm` | PostgreSQL connection string |
| `CSM_SQLITE_PATH` | — | SQLite database path |
| `CSM_EMBEDDING_PROVIDER` | `ollama` | Embedding provider |
| `CSM_EMBEDDING_DIMENSIONS` | `768` for Ollama, `1536` for OpenAI | Expected vector dimension; changing it requires a schema migration |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama endpoint |
| `OPENAI_API_KEY` | — | Required when the OpenAI embedding provider is selected |
| `CSM_REENTRY_PREVIEW_ONLY` | `false` | Preview re-entry instead of injecting it |
| `CSM_BELIEF_PROMOTION_ENABLED` | `false` | Enable controlled belief promotion |

Configuration is loaded from the environment and validated before the runtime starts.

## Repository map

```text
src/                 Runtime, storage, recall, governance, hooks, and tools
src/hooks/           OpenCode lifecycle integration and system transforms
src/schema/          PostgreSQL and SQLite schema ownership
test/                Main automated regression suite
scripts/             Database, audit, benchmark, and operational commands
migrations/          Migration artifacts and historical schema changes
docs/                Product docs, contracts, evidence, and phase history
AGENTBOOK_STATE.md   Generated turn-1 project state
AGENTS.md            Repository operating guidance
```

## Development gates

```bash
npm run typecheck
npm run build
npm run lint:src
npm test
npm run drill:backup-restore
```

The source lint gate is locked at zero errors and a bounded warning baseline. Database-sensitive changes should also exercise schema initialization, migration compatibility, and the backup/restore drill.

Contribution expectations are defined in [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- [Documentation index](docs/README.md)
- [Feature and tool map](docs/FEATURES.md)
- [Product architecture](docs/PRODUCT_ARCHITECTURE.md)
- [Re-entry protocol](docs/PHASE7_REENTRY_PROTOCOL.md)
- [Continuity resilience report](docs/PHASE6E_CONTINUITY_RESILIENCE_REPORT.md)
- [Recall-quality scoring](docs/PHASE6D_RECALL_QUALITY_SCORING.md)
- [Belief-promotion pipeline](docs/PHASE4G_BELIEF_PROMOTION_PIPELINE.md)
- [SQLite MVP](docs/PHASE3G_SQLITE_MVP.md)
- [Project phase history](docs/PHASE_HISTORY.md)

## Project status

CSM is actively developed and currently optimized for local and self-hosted agent workflows. The repository is source-first, PostgreSQL is the complete feature path, and SQLite provides a deliberately narrower local core.

## Security

Memory systems can retain sensitive project context. Review [SECURITY.md](SECURITY.md) before using CSM with private source code, credentials, customer data, or regulated information.

## License

MIT. See [LICENSE](LICENSE).

# Cross-Session Memory (CSM)

> Persistent memory and operational continuity for AI coding agents in opencode.

CSM gives your agent cross-session memory, project continuity, self-awareness, and an operational ledger � so every new session starts where the last one left off.

## What it does

### AgentBook � Operational Ledger
An append-only event journal that records every meaningful action (file edits, commands, decisions, commits, blockers, test runs) and projects a continuously updated **front page** that tells a fresh agent exactly where the project stands.

- **Turn-1 injection** via `opencode.json` `instructions` � read at startup, before any plugin hooks. No race condition.
- **Auto-regeneration** � the front page updates after every tool call.
- **Rolling summaries** � generated at thresholds (50 events or 20K characters).
- **Explicit rules** � project/session/global operating policy with priority and override semantics.

### Cross-Session Memory
- **Memories**: conversation, workspace, repo, preference, lesson, episodic, procedural
- **Hybrid search**: vector + full-text + entity-boost with type/tag/importance filters
- **Dedup & merge**: exact-content detection, safe supersede (no deletion)
- **Governance**: quality scoring, archive candidates, stale detection, refresh summaries
- **Embedding backfill**: batch, resume, rate-limited

### Living State Layer
- **Experience packets**: structured observations from tool execution (success, error, milestone, decision)
- **Self-model**: per-capability confidence tracking with success/failure reconciliation
- **Belief knowledge**: revisable claims, preferences, and worldviews with evidence backing
- **Advisory context brief**: injected alongside onboarding for internal-state awareness

### Onboarding & Re-entry
- **Startup packet**: identity brief, project continuity, phase/checkpoint, constraints, relevant memories, promoted beliefs, advisories, tool guidance, handoff state, readiness summary
- **Re-entry protocol**: 8-layer contextual block with priority-based token trimming
- **Source attribution diagnostic**: distinguishes CSM-injected context from AGENTS.md

## Quickstart

### PostgreSQL (default)

```bash
# Set your database URL
export CSM_DATABASE_URL=postgres://user:pass@localhost/csm

# Or use the default (localhost)
# The plugin connects automatically on startup
```

### SQLite (zero-dependency)

```bash
export CSM_DATABASE_PROVIDER=sqlite
export CSM_SQLITE_PATH=.data/csm.sqlite
```

### Install the plugin

The plugin loads via `.opencode/plugins/csm.js`. Add `AGENTBOOK_STATE.md` to your `opencode.json` instructions for turn-1 continuity:

```json
{
  "instructions": ["AGENTS.md", "AGENTBOOK_STATE.md"]
}
```

## Configuration

| Env Var | Default | Description |
|---|---|---|
| `CSM_DATABASE_PROVIDER` | `postgres` | Database provider (`postgres` or `sqlite`) |
| `CSM_DATABASE_URL` | `postgres://localhost/csm` | PostgreSQL connection string |
| `CSM_SQLITE_PATH` | � | SQLite database file path (required if provider=sqlite) |
| `CSM_EMBEDDING_PROVIDER` | `ollama` | Embedding provider (`ollama` or `openai`) |
| `OPENAI_API_KEY` | � | OpenAI API key (required if provider=openai) |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama host URL |
| `CSM_REENTRY_PREVIEW_ONLY` | `false` | Re-entry injection mode (false = live, true = preview) |
| `CSM_BELIEF_PROMOTION_ENABLED` | `false` | Enable belief promotion to durable memory |

## Tools

CSM registers 37 tools under the `csm_` prefix:

### AgentBook (3)
`csm_agentbook_events`, `csm_agentbook_state`, `csm_agentbook_rule`

### Memory (10)
`csm_memory_save`, `csm_memory_search`, `csm_memory_list`, `csm_memory_delete`, `csm_memory_distill`, `csm_memory_merge`, `csm_memory_dedup_detect`, `csm_memory_backfill_embeddings`, `csm_memory_compact`, `csm_memory_related`

### Onboarding & Re-entry (3)
`csm_onboard_agent`, `csm_reentry_preview`, `csm_context`

### Living State (7)
`csm_belief_scan`, `csm_belief_scan_report`, `csm_belief_knowledge`, `csm_belief_promotion_scan`, `csm_self_model`, `csm_living_state_preview`, `csm_living_state_debug`

### Governance (7)
`csm_memory_governance_report`, `csm_memory_archive_candidate_report`, `csm_memory_candidate_generate`, `csm_memory_candidate_report`, `csm_recall_quality_report`, `csm_continuity_report`, `csm_work_ledger_surviving`

### Diagnostics (7)
`csm_runtime_status`, `csm_memory_packets`, `csm_memory_transcript`, `csm_memory_distilled_view`, `csm_compaction_audit`, `csm_reentry_preview`, `csm_context_review`

## Architecture

```
Agent actions
    ?
append-only event ledger (agentbook_events)
    ?
structured extraction ? rolling summaries (agentbook_summaries)
    ?
current-state projection (agentbook_current_state)
    ?
front-page markdown (AGENTBOOK_STATE.md)
    ?
fresh-session injection via opencode.json instructions
```

```
CSM memories          long-term facts and lessons
Experience packets    structured observations
Beliefs/self-model    inferred internal state
AgentBook events      operational project history
AgentBook current     authoritative working state
Ruleset               explicit behavior policy
```

CSM is broad memory. AgentBook is the agent's working autobiography and project ledger.

## Database Schema

### PostgreSQL
25 migrations tracking schema evolution. See `src/schema/postgres-migrations.ts`.

### SQLite
7 core tables + 4 AgentBook tables, all indexed. See `src/schema/sqlite/index.ts`.

### AgentBook Tables
- `agentbook_events` � append-only operational ledger
- `agentbook_summaries` � rolling rollups linked to event ranges
- `agentbook_current_state` � derived per-project snapshot
- `agentbook_rules` � explicit operating policy

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests (requires PostgreSQL or SQLite)
npm test

# Typecheck
npx tsc --noEmit

# Lint (src only, baseline locked at 7 warnings)
npm run lint:src
```

### Lint Baseline
- 0 errors, 7 warnings (all in `opentui.d.ts`, external API types, skipped by design)
- `max-warnings=7` on `lint:src` prevents unbounded growth
- Test files excluded from `lint:src` with relaxed rules

### Test Status
- **1571/1571 pass**
- 20 AgentBook tests covering event store, rules store, state projector, summary generator, and front page generation

## Project History

Phases 1A-4F-C, 7A-9B, L1-L4-K, and capability promotion closure are complete. Full per-phase detail is archived in `docs/PHASE_HISTORY.md`.

## License

MIT

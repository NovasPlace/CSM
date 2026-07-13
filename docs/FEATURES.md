# Feature Map

This document is the product-level inventory for Cross-Session Memory. It describes the major subsystems, the runtime tool surface, provider differences, and the trust boundaries that shape behavior.

For setup, start with the [main README](../README.md). For data flow and module boundaries, see [PRODUCT_ARCHITECTURE.md](PRODUCT_ARCHITECTURE.md).

## Product model

CSM is composed of five durable information layers:

| Layer | Primary question |
|---|---|
| **Memory** | What has been learned across sessions? |
| **AgentBook** | What is happening in this project right now? |
| **Living State** | What has the agent observed about its own capabilities, beliefs, and recurring outcomes? |
| **Work continuity** | What goal, checkpoint, decision, error, or unfinished thread must survive? |
| **Context control** | What should be active now, compacted, cached, or fetched later? |

Those layers are connected by retrieval, re-entry, governance, and provider-specific storage adapters.

## Capability matrix

### Durable memory

- Save, search, list, and delete memories
- Store lessons and transcript-oriented records
- Hybrid vector and full-text retrieval
- Entity, tag, type, and importance-aware filtering
- Related-memory traversal
- Distillation and compacted views
- Embedding backfill
- Exact duplicate detection
- Non-destructive merge and supersede
- Archive-candidate generation
- Memory governance reports

### AgentBook

- Append-only operational event journal
- Tool-aware event classification
- File-path, command, result, and failure evidence
- Per-project and per-session filtering
- Rolling threshold summaries
- Current-state projection
- Project, session, and global rules
- Priority and override semantics
- Markdown front-page generation
- Turn-1 loading through `AGENTBOOK_STATE.md`

### Re-entry and onboarding

- Agent identity and self-continuity
- Project, phase, and active-goal reconstruction
- Checkpoint and handoff recovery
- Constraints and explicit rules
- Relevant memories and decisions
- Promoted knowledge and advisories
- Source attribution
- Priority-based token trimming
- Preview mode
- Source-only recovery guards
- Readiness summaries

### Context control

- Context-pressure and token-bucket analysis
- Compaction and compaction audit
- Persistent context cache
- Context manifest generation
- Selective context search and fetch
- File-region retrieval
- Last-error retrieval
- Decision-log retrieval
- Context-fault recovery surface
- Checkpoint creation and reference expansion
- Goal-aware system transformation
- Cross-session causal stitching

### Living State

- Structured experience packets
- Success, failure, milestone, decision, and observation events
- Per-capability confidence
- Success/failure reconciliation
- Belief-candidate scanning
- Evidence-backed belief knowledge
- Controlled belief promotion
- Preview and debug surfaces
- Advisory context generation

### Governance and quality

- Recall-quality reports
- Continuity resilience reports
- Provenance and source attribution
- Direct, inferred, and gap evidence distinctions
- Duplicate detection
- Safe merge and supersede
- Archive-candidate reporting
- Migration ledgers
- Provider-aware tool removal
- Backup/restore verification
- Bounded lint and CI gates

### Work and documentation continuity

- Goal set, update, and list tools
- Checkpoint creation, expansion, and listing
- Work-ledger survival
- Session handoff state
- Auto-generated architecture, decisions, changelog, runbook, system map, debug notes, and agent memory
- Project-scoped, race-safe documentation flushing

## Runtime tool catalog

The full PostgreSQL path can register up to 50 tools. Two tools are conditional on runtime components, and SQLite removes tools that are not implemented for its provider.

### Memory and governance — 19

| Tool | Purpose |
|---|---|
| `csm_memory_save` | Save a durable memory |
| `csm_memory_search` | Search memory with the configured recall pipeline |
| `csm_memory_list` | List stored memories |
| `csm_memory_delete` | Delete through the memory manager contract |
| `csm_memory_context` | Build memory context for the current task |
| `csm_memory_lesson` | Save or retrieve reusable lessons |
| `csm_memory_transcript` | Work with transcript-oriented memory |
| `csm_memory_distill` | Distill source material into durable memory |
| `csm_memory_distilled_view` | Read distilled memory views |
| `csm_memory_compact` | Compact active context |
| `csm_memory_related` | Traverse related memories |
| `csm_memory_packets` | Query experience packets |
| `csm_memory_backfill_embeddings` | Backfill missing embeddings |
| `csm_memory_dedup_detect` | Detect duplicate candidates |
| `csm_memory_merge` | Merge duplicates without discarding provenance |
| `csm_memory_candidate_generate` | Generate maintenance candidates |
| `csm_memory_candidate_report` | Review generated candidates |
| `csm_memory_archive_candidate_report` | Report likely archive candidates |
| `csm_memory_governance_report` | Summarize governance and quality state |

### Living State — 8

| Tool | Purpose |
|---|---|
| `csm_belief_scan` | Scan for belief candidates |
| `csm_belief_scan_report` | Report belief-scan findings |
| `csm_belief_promote` | Promote approved belief knowledge |
| `csm_belief_promotion_scan` | Scan promotion readiness |
| `csm_self_model` | Inspect capability confidence |
| `csm_belief_knowledge` | Query evidence-backed belief knowledge |
| `csm_living_state_preview` | Preview the Living State advisory block |
| `csm_living_state_debug` | Inspect Living State decisions and inputs |

### AgentBook — 3

| Tool | Purpose |
|---|---|
| `csm_agentbook_events` | Query event history, cursors, and counts |
| `csm_agentbook_state` | Project current state and render the front page |
| `csm_agentbook_rule` | Add, list, or deactivate explicit rules |

### Continuity and runtime — up to 7

| Tool | Purpose |
|---|---|
| `csm_runtime_status` | Report runtime, provider, and memory status |
| `csm_compaction_audit` | Inspect compaction behavior |
| `csm_recall_quality_report` | Report recall-quality measurements |
| `csm_continuity_report` | Build the continuity resilience report |
| `csm_onboard_agent` | Build an onboarding packet |
| `csm_reentry_preview` | Preview re-entry output when the protocol is available |
| `csm_work_ledger_surviving` | Query surviving work-ledger state when enabled |

### Checkpoints and goals — 6

| Tool | Purpose |
|---|---|
| `create_checkpoint` | Create a continuity checkpoint |
| `expand_checkpoint_ref` | Expand a checkpoint reference |
| `list_checkpoints` | List available checkpoints |
| `goal_set` | Set the active goal |
| `goal_update` | Update goal state |
| `goal_list` | List goals |

### Context cache and review — 7

| Tool | Purpose |
|---|---|
| `context_review` | Review available context |
| `context_fetch` | Fetch cached context |
| `context_search` | Search the context cache |
| `context_fetch_file_region` | Fetch a bounded file region |
| `context_fetch_last_error` | Retrieve recent error context |
| `context_fetch_decision_log` | Retrieve decision evidence |
| `context_fault` | Invoke the virtual-context fault surface |

## Provider availability

### PostgreSQL

PostgreSQL is the complete path. It owns the advanced maintenance, Living State, governance, context-cache, checkpoint, goal, re-entry, and reporting features.

The repository CI matrix validates PostgreSQL 14 and 16.

### SQLite

SQLite is a local core mode. Unsupported tools are removed during registration instead of being left visible and failing at execution time.

The core SQLite surface includes the foundational memory, AgentBook, runtime, and onboarding behavior that has an implemented SQLite contract. Advanced PostgreSQL-only systems remain unavailable.

## Safety and trust boundaries

### Append-only where history matters

AgentBook events are append-only. Summaries and current-state projections are derived from event history rather than replacing it.

### Non-destructive maintenance

Duplicate handling uses merge and supersede semantics so original evidence can remain available for audit and rollback.

### Preview before promotion

Re-entry and belief-related systems expose preview or explicit enablement controls where behavior could materially affect future agent decisions.

### Provider honesty

The runtime removes tools that are not supported by the selected database provider. Provider differences are explicit rather than hidden behind partial behavior.

### Source attribution

Re-entry and governance surfaces distinguish CSM-produced context from repository instructions and other sources.

### Bounded context

Context injection is priority-aware and token-bounded. The system is designed to omit or defer lower-priority material rather than overflow the active prompt.

## Feature ownership in the repository

| Area | Primary locations |
|---|---|
| Tool registration | `src/hooks/tool-hooks.ts` |
| Tool names | `src/tool-names.ts` |
| Core memory tools | `src/tools.ts`, `src/maintenance-tools.ts` |
| AgentBook | `src/agentbook-*.ts` |
| Re-entry | `src/re-entry-protocol.ts`, `src/reentry-*.ts` |
| Living State | `src/living-state-*.ts`, `src/belief-*.ts`, `src/self-model-*.ts` |
| Context cache | `src/context-cache-*.ts` |
| Checkpoints and goals | `src/checkpoint-*.ts`, `src/goal-*.ts` |
| Governance | `src/*governance*`, `src/*quality*`, `src/continuity-resilience-report.ts` |
| Storage | `src/database.ts`, `src/db/`, `src/schema/` |
| Lifecycle hooks | `src/hooks/`, `src/hooks-registration.ts` |
| Verification | `test/`, `.github/workflows/ci.yml`, `scripts/backup-restore-drill.ts` |

## Reading path

1. [README](../README.md) — product overview and setup
2. [Product architecture](PRODUCT_ARCHITECTURE.md) — runtime and data flow
3. [Re-entry protocol](PHASE7_REENTRY_PROTOCOL.md) — continuity injection
4. [Continuity resilience report](PHASE6E_CONTINUITY_RESILIENCE_REPORT.md) — health model
5. [Recall-quality scoring](PHASE6D_RECALL_QUALITY_SCORING.md) — retrieval evaluation
6. [Belief-promotion pipeline](PHASE4G_BELIEF_PROMOTION_PIPELINE.md) — Living State promotion
7. [SQLite MVP](PHASE3G_SQLITE_MVP.md) — local provider contract
8. [Phase history](PHASE_HISTORY.md) — implementation chronology

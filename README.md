# Cross-Session Memory Plugin

A full-stack memory and context management system for AI coding assistants. Persists knowledge across sessions, compacts context on the fly, checkpoints progress, and auto-documents your codebase, all backed by PostgreSQL and pgvector.

## Quick Start

```bash
npm install
npm run build
npm run verify
```

If you want the design story, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). This README stays focused on getting the plugin running.
If you want the public store plan, read [docs/STORE_SUBMISSION.md](docs/STORE_SUBMISSION.md).

## What It Does

This plugin gives an AI assistant long-term memory. Without it, every new session starts from zero. With it, the assistant remembers what it did last session, what decisions were made, what went wrong, what the codebase looks like, and where it left off.

### Memory System
- **Cross-session persistence** - Memories are stored in PostgreSQL and survive session restarts. Every session can recall, search, and build on knowledge from prior sessions.
- **Host-neutral bridge path** - The Postgres memory core can be reached from OpenCode or from the Codex bridge export without rewriting `MemoryManager`.
- **csm_ tool namespace** - All memory tools are now prefixed `csm_` (e.g. `csm_memory_save`, `csm_memory_search`) to avoid collisions with host tool registries. A `csm_runtime_status` diagnostic tool is included.
- **Prompt message normalization** - Sanitizes prompt messages to valid SDK chat roles (user/assistant/tool), converts system messages to assistant, and drops invalid messages before context compilation.
- **Cascade search fallback** - Search and list operations cascade through `project → legacy → global` modes when the primary mode returns zero results.
- **Text search fallback** - If vector search fails (e.g. missing embeddings), a `LIKE`-based text search fallback activates automatically.
- **Automatic memory extraction** - After every assistant turn, raw conversation text is distilled into structured semantic memories with no user effort.
- **Memory types** - `conversation`, `workspace`, `repo`, `preference`, `lesson`, `episodic`, and `procedural`.
- **Hybrid search** - Queries use Reciprocal Rank Fusion across vector similarity, full-text search, and entity matching.
- **Explicit recall telemetry** - Search, list, and context recall write `memory_recall_events` rows with hashed queries only. No raw query text is stored by default.
- **Concept extraction and knowledge graph** - Concepts are extracted from memory content and linked together for entity-aware recall.
- **Prune scoring** - Dry-run prune scoring now accounts for recall frequency so old but frequently used memories stay protected.
- **Manual embedding backfill** - Legacy rows with `embedding IS NULL` can be repaired explicitly through runtime/API backfill. This never runs automatically on startup.

### Context Pipeline
- **Context compilation** - Builds a token-budgeted manifest from recent work, goals, lessons, and project context.
- **Adaptive Context Governor (Phase 32)** - Applies budget-aware pressure monitoring, light memory briefs, checkpoint refs, distilled project state, and emergency rebuilds to keep long sessions under target prompt budgets.
- **Verified quota savings (Phase 32.5)** - Benchmarked results show `53.5%` synthetic long-session input reduction, `63.9%` captured-trace input reduction, peak active context dropping from `156,532` to `31,687`, and context pressure moving from turn `93` to turn `240` while preserving continuity. Live workspace replay now shows a `7.3%` reduction on the latest trace rerun. Live production data across 10,302 compactions confirms an **81.9% average savings** (2B+ tokens saved).
- **Workspace replay proof** - Real prompt-debug workspace replay now shows `7.3%` reduction on the latest rerun, proving the governor affects messy organic traces rather than only synthetic paths.
- **Vault trace capture (Phase 33)** - Real work-journal traces are now persisted as vault records before distillation, so the system can replay a compact evidence trail instead of the full raw journal.
- **Teacher traces (Phase 33)** - Those vault records can be distilled into compact repair cards, saved as lesson memories, and replayed through bridge recall with less token spend than the raw journal trail.
- **Phase 33 evidence** - Reproducible results and raw outputs are documented in `docs/PHASE33_TRACE_VAULT_RESULTS.md` and `docs/PHASE33_TRACE_VAULT_RAW_OUTPUTS.md`.
- **Codex context brief** - `CodexMemoryBridge.getContextBrief({ projectRoot, task })` builds a compact brief plus lesson/risk recall before a fresh Codex task burns context rediscovering the repo.
- **Tool-call distillation** - Converts raw tool output into structured summaries and references.
- **Assistant text compaction** - Compresses long assistant text while preserving important lines.
- **Compaction quality gate** - Rejects unsafe compactions instead of silently dropping signal.
- **Context rollover** - Generates a continuation brief when prompt pressure gets too high.
- **Evidence package** - Reproducible benchmark claims and raw outputs are documented in `docs/PHASE32_CONTEXT_GOVERNOR_RESULTS.md` and `docs/PHASE32_CONTEXT_GOVERNOR_RAW_OUTPUTS.md`.

### Checkpoint System
- **Session checkpoints** - Snapshots current work into durable PostgreSQL-backed checkpoints.
- **Auto-checkpointing** - Queues checkpoints before risky operations.
- **Checkpoint markdown** - Renders checkpoints into readable summaries for debugging and handoff.

### Governance Threshold Testing (Phase 32.5A)
- **Memory "Teeth" Proof** - V2-M6.5A synthetic governance test proves prior memory records can actually veto future agent behavior, not just provide context.
- **Provenance Completeness Gate** - Validates that governance records must have direct evidence (source_kind, evidence_strength, source_session_id, source_agent_id, source_model_id, source_surface) to constrain actions.
- **Evidence Strength Classification** - Distinguishes direct_original, direct_summary (with derivative_of tracking), inferred, and gap records.
- **Governance Eligibility** - Only governance_eligible records can veto behavior; context_only and gap_record are for context/audit only.
- **Prevents Fake Continuity** - System correctly reports what it knows directly, what it infers, and what's missing (direct | inferred | gap discipline).

### Cross-Session Causal Stitching (Phase 31)
- **No silent continuity inference** - Every cross-session edge is labeled `direct`, `inferred`, or `gap`; missing proof is preserved instead of smoothed over.
- **Dedicated stitch graph** - `cross_session_causal_links` stores cross-session causal edges with confidence, evidence anchors, gap kinds, and metadata.
- **Failure-to-growth chain** - Stitches `failure → diagnosis → correction → lesson → later recall → changed behavior → improvement signal`.
- **Canonical proof chain** - Ships a deterministic Session D → Session E → Phase 22 → 23 → 24 → 25 → 26 → 27 stitching path with explicit gap preservation.
- **Narrative integration** - `PhaseNarrativeBuilder` now includes cross-session links and measurable growth evidence in injection text.
- **Deep continuity injection** - When the user asks about continuity/memory/identity, hydrated records, causal threads, failure traces, and phase causation chains are injected directly into the system prompt.
- **Greeting/workspace guard** - Simple greetings and workspace-fact queries are detected at the system transform hook to prevent unnecessary memory tool calls.

### Schema Refactor
- **Declarative schema pipeline** - `database.ts` inlined schema was extracted into `src/schema/` with per-subsystem files (`core-schema.ts`, `memory-schema.ts`, `session-schema.ts`, `project-isolation-schema.ts`).
- **Step-by-step init with error isolation** - `initializeAllSchemas` runs each schema step in order, logging failures instead of aborting the entire init.
- **Narrative refactor** - `PhaseNarrativeBuilder` internals moved to `self-continuity-narrative-format.ts`, `self-continuity-narrative-canonical.ts`, and `self-continuity-narrative-types.ts` for separation of concerns.

### Response Mode Selector (Phase 29)
- **Adaptive depth** - Auto-selects 'basic' (boundary-only) or 'deep' (boundary + evidence + causal chain + narrative arc) based on available hydration context.
- **Drivers**: record count, thread presence, phase narrative, user hints ('deep', 'narrative', 'why', 'how')
- **Graceful fallback** — deep mode degrades to basic when context insufficient.

### Value Source Guard (Phase 28)
- **Known vs inferred values** - Distinguishes explicitly stored user preferences from values inferred from the project arc. Prevents self-models from treating inferences as confirmed facts.
- **Classification** - `classifyValueClaim`, `guardValueSources`, `detectUnlabeledInferences`. Tags each value claim with source ('known' | 'inferred'), evidence, and confidence.

### Phase Narrative Builder (Phase 27)
- **Causal chain reconstruction** - Connects phases 21-26 into a narrative: problem → action → result → downstream change. Turns index-card continuity into narrative continuity.
- **Causation anchors** - Uses real A/D/E experiment results as fixtures. Session D proved silent recall → Phase 22 drift tracking → Phase 23 evidence hydration → Phase 24 causal threads → Phase 25 depth scoring → Phase 26 integration.
- **Gap detection** - Reports missing links in the chain instead of hallucinating causation.
- **Token budget** - Respects max token limit for context injection.

### Self-Continuity Integration (Phase 26)
- **Unified injection path** - Wires causal thread hydration into self-continuity record injection, so context compilation automatically includes the "why" behind each record.
- **Two hydrators as one** - `SelfContinuityIntegration` combines `SelfContinuityHydrator` (canonical fields) and `CausalThreadHydrator` (problem/action/result chains) into a single call.
- **Graceful degradation** - Thread hydration failure falls back to record-only hydration; never blocks normal recall.
- **Dependency injection** - Accepts hydrator instances for testability.

### Hydration Depth Scoring (Phase 25)
- **Depth vs stability** - Separate metric from drift tracking: a self-model answer can be perfectly stable (no overclaim) but shallow (no evidence). These are orthogonal dimensions.
- **5 dimensions** - record_citation, session_phase_naming, evidence_anchor_depth, causal_chain_reconstruction, gap_reporting.
- **Verdicts** - shallow (< 0.3), moderate (0.3-0.55), deep (>= 0.55).
- **Integration** - Feeds into drift tracking as an independent axis; high stability + high hydration = robust self-model.

### Causal Thread Hydration (Phase 24)
- **Narrative continuity** - Reconstructs the causal thread around a recalled memory: problem → action → result → decision → lesson → downstream change.
- **Causal vs temporal** - Distinguishes causal links (memory_links type=causal/reference) from pure temporal adjacency, reporting lower confidence for temporal-only chains.
- **Gap reporting** - Broken chains report explicit gaps (`missing_diff`, `missing_reason`, `missing_result`, `broken_link`) instead of hallucinating reasons.
- **Role classification** - Pattern-based classification with priority: lesson → decision → downstream_change → result → action → problem.
- **Token budget** - Max 2000 chars by default; graceful failure never blocks normal recall; redaction still applies.

### Self-Continuity Evidence Hydration (Phase 23)
- **Canonical hydration** - When a self-continuity record is recalled, its canonical self-observation and evidence anchors are injected directly via a dedicated `SelfContinuityHydrator` path — bypassing lossy generic/episodic compression.
- **Canonical fields** - record_id, created_at, trigger_type, self_observation, evidence_anchors, continuity_gap, confidence_score, drift_summary, similarity_method.
- **Guards** - Max 3 records enforced, synthetic_test excluded, redaction applied, fallback to summary on failure without blocking.
- **Weighted confidence** - Each record carries a confidence score based on evidence strength, recency, and source reliability.
- **Natural recall** - Proven in live experiments: agents naturally cite continuity records when asked about identity/continuity without explicit prompting.

### Self-Model Drift Tracking (Phase 22)
- **5-dimension stability metric** - Measures whether the agent's self-continuity model stabilizes or drifts across sessions.
- **Dimensions**: evidence anchoring, reconstruction boundary, uncertainty preservation, subjective overclaim, recursive awareness.
- **Anchor fixtures** - Grounded in real experiment results (Sessions A/D/E), not theoretical.
- **Verdict system** - `stable` / `mild_drift` / `significant_drift` based on weighted scoring across all dimensions.

### Auto-Documentation System
- **Multi-directory source detection** - `reconcileSystemMap` auto-detects source directories (`src/`, `lib/`, `core/`, `harness/`, `engine/`, `modules/`, `packages/`, and any directory containing `.ts`/`.js` files), not just `src/`.
- **Root-level protocol tracking** - Tracks README, MANIFESTO, IMPLEMENTATION_AGENT_PROTOCOL, ARCHITECTURE, DECISIONS, RUNBOOK, CHANGELOG at the project root.
- **New directory auto-documentation** - When the subconscious watcher detects a new directory without a README, it auto-generates one and feeds it into the auto-docs pipeline.
- **Recursive output protection** - Auto-docs output files (SYSTEM_MAP.md, CHANGELOG_LIVE.md, DECISIONS.md, AGENT_MEMORY.md) are tracked for reads but excluded from write-triggered recursion loops.
- **Section auto-creation** - `updateDocContent` creates missing sections instead of silently skipping unknown headers.

### Subconscious Watcher
- **File change detection** - Periodic scan detects created/modified/deleted files and captures them as episodic memories.
- **New directory detection** - Directories without a prior scan record trigger `handleNewDirectory()`, which auto-generates a README and triggers `autoDocumentChange()`.
- **Structural directory protection** - Skips `src/`, `test/`, `docs/`, `plugins/`, `migrations/` and their subdirectories to prevent cluttering known project areas with auto-generated READMEs.
- **Build artifact filtering** - Skips `node_modules`, `dist`, `.next`, source maps, minified/hashed files.

### Agent Work Journal
- **Live incremental capture** - Every tool call, decision, and session boundary is recorded to the work journal in real time.
- **Resume payload injection** - When a session resumes, the prior session's work journal is injected as a compact resume brief so the agent can pick up where it left off.
- **Auto milestone marking** - Milestones are detected and recorded automatically based on tool call patterns.
- **Persist on dispose** - Session end persists the journal automatically.

### Lesson Trigger Cache
- **Pattern-based lesson recall** - Lessons with trigger patterns (tool names, file extensions, arg regexes) are cached and matched against each tool call before execution.
- **Contextual warnings** - When a tool call matches a lesson's trigger pattern, a warning is injected before the tool runs, preventing repeated mistakes.
- **System prompt injection** - Active lessons are injected into the system prompt so the model sees relevant lessons before generating responses.

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

Current source of truth is the test runner output. The suite includes fresh-schema and Phase 19b integration coverage for clean installs, explicit backfill, and hashed recall telemetry, and it continues to grow as new phases land.

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
| `cross-session-causal-stitcher` | Cross-session causal stitching: failure-to-growth chains, canonical proof chain, gap preservation |
| `cross-session-causal-store` | Cross-session causal store: link CRUD, session lookup |
| `bridge-ops` | Bridge operations: search cascade, list cascade, context brief |
| `prompt-message-sanitizer` | Prompt normalization: system message conversion, invalid message dropping |
| `system-transform-greeting` | Greeting/workspace-fact detection in system transform hook |

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
- `memory_delete`
- `memory_context`
- `memory_lesson`
- `memory_transcript`
- `memory_candidate_list`
- `memory_candidate_approve`
- `memory_candidate_reject`
- `memory_project_list`
- `memory_cleanup`
- `memory_distill`
- `memory_distilled_view`
- `memory_compact`
- `memory_backfill_embeddings`
- `context_review`
- `context_fetch`
- `context_search`
- `context_fetch_file_region`
- `context_fetch_last_error`
- `context_fetch_decision_log`
- `goal_set`
- `goal_update`
- `goal_list`
- `csm_context_pressure`
- `create_checkpoint`
- `list_checkpoints`
- `expand_checkpoint_ref`
- `csm_runtime_status`
- `csm_compaction_audit`
- `preview_teacher_traces`
- `seed_teacher_traces`
- `capture_trace_vault`
- `preview_trace_vault`
- `seed_teacher_traces_from_vault`
- `prune_memories_dry_run`
- `backfill_missing_embeddings`
- `get_compaction_report`

`get_context_brief` is the primary entry point for a fresh Codex task. It creates or reuses a bridge session for the project root, refreshes context, and returns the compact brief plus relevant lessons and active risks.

## Codex MCP Server

`src/codex-mcp-server.ts` exposes the bridge as a JSON-RPC MCP server for Codex or other MCP clients. Configure via `.mcp.json`:

```json
{
  "mcpServers": {
    "cross-session-memory-bridge": {
      "cwd": ".",
      "command": "node",
      "args": ["./dist/codex-mcp-server.js"]
    }
  }
}
```

## csm_ Tool Namespace

All memory tools are registered with the `csm_` prefix to avoid collisions:

| Tool | Description |
|------|-------------|
| `csm_memory_save` | Save information to cross-session memory |
| `csm_memory_search` | Semantic search across memories |
| `csm_memory_list` | List memories with filters |
| `csm_memory_delete` | Delete a memory by ID |
| `csm_memory_context` | Get current session context brief |
| `csm_memory_lesson` | Save a lesson learned |
| `csm_memory_transcript` | Get conversation transcript |
| `csm_memory_distill` | Distill recent tool-call activity |
| `csm_memory_distilled_view` | View distilled summaries |
| `csm_memory_compact` | Report on compaction savings |
| `csm_memory_backfill_embeddings` | Repair missing embeddings |
| `csm_context_pressure` | Inspect an explicit message snapshot against the context window |
| `csm_compaction_audit` | Audit compaction telemetry for correctness |
| `csm_runtime_status` | Diagnostic: plugin status, DB connectivity, tool registry |

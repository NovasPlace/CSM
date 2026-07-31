---
name: csm-continuity
description: Use the complete native Cross-Session Memory (CSM) runtime for continuity, memory governance, living state, beliefs, self-model, AgentBook, checkpoints, context cache, goals, work ledger, compaction, re-entry, or handoff across Codex tasks.
---

# CSM Continuity

Use the plugin's full CSM runtime without treating memory as more authoritative than the current workspace. Native hooks automatically capture session, prompt, tool, compaction, subagent, and stop events; do not duplicate routine hook capture manually.

## Start or resume work

1. Resolve `projectRoot` to the current workspace root. Keep every read and write scoped to it.
2. Call `csm_runtime_status` before the first memory operation. If the runtime is unavailable or points at the wrong provider, stop and report the configuration problem.
3. If the injected onboarding and `<agent_reentry_context>` are insufficient, call `csm_onboard_agent`, `csm_reentry_preview`, or `bridge_resume_context` with `projectRoot` and the user's current task.
4. Use `csm_memory_search`, `csm_memory_context`, `recall_lessons`, or `get_context_brief` only when the resumed context needs focused evidence.
5. Verify recalled claims against current files, tests, and user instructions before acting on them.

## Preserve useful state

- Native tool hooks already record tool evidence, work-journal entries, experience packets, AgentBook events, and living-state triggers. Use `bridge_sync_turn` only for an additional durable milestone that automatic capture cannot infer.
- Use `memory_lesson` for a reusable lesson and `save_memory` for an explicitly useful durable record.
- Never persist credentials, secrets, access tokens, private keys, or unnecessary sensitive content. Redact before saving.
- Prefer evidence and provenance over broad claims. Current repository state remains the source of truth.

## Checkpoint and hand off

1. Before compaction, interruption, or a risky transition, inspect `csm_context_pressure` when an explicit message snapshot is available.
2. Use `create_checkpoint` when the current state would be expensive to reconstruct.
3. Before stopping or transferring work, sync the final durable milestone and call `bridge_handoff_summary`.
4. Make the handoff concrete: outcome, files changed, verification, open risks, and next action.

## Full system surface

- Memory and governance: `csm_memory_*`, candidates, dedup, merge, archive, governance, recall quality, and continuity reports.
- Living state: `csm_memory_packets`, beliefs, promotion scans, `csm_self_model`, `csm_living_state_*`, and related-memory graph tools.
- Operational continuity: AgentBook, checkpoints, context cache/fault tools, goals, onboarding, wiki export, work ledger, and re-entry preview.
- Prefer read-only preview/report tools first. Treat promotion, merge, archive, deletion, cleanup, rule changes, and export writes as mutations.

## Mutation safety

- Treat delete, cleanup, candidate approval or rejection, embedding backfill, and trace seeding as mutations.
- Preview when a dry-run tool exists. Perform destructive or bulk operations only when the user explicitly requests them.
- Do not cross project boundaries to fill gaps in recall.

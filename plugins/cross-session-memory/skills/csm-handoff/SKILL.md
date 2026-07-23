---
name: csm-handoff
description: Checkpoint expensive state and write a concrete handoff before stopping, compaction, or transferring work in Claude Code.
---

# CSM Handoff

Make every transition cheap to resume. Scope all calls to the current `projectRoot`.

## When to hand off

- Before stopping, before an expected compaction, or before transferring work to another session or person.
- When context pressure is high — inspect `csm_context_pressure` when a message snapshot is available.

## Procedure

1. Resolve `projectRoot` to the current workspace root.
2. If the current state is expensive to reconstruct, `create_checkpoint`. Check `list_checkpoints` to avoid redundant checkpoints.
3. Record the final durable milestone with `bridge_sync_turn`, then call `bridge_handoff_summary`.
4. Write the handoff concretely: outcome, files changed, verification performed, open risks, and the single next action.

## Safety

- Never persist secrets, credentials, tokens, or unnecessary sensitive content — redact first.
- State outcomes faithfully: if tests failed or a step was skipped, say so.

The `csm-handoff-writer` agent can perform this whole procedure autonomously.

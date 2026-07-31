---
description: Write a concrete handoff summary before stopping or transferring work.
argument-hint: [optional focus]
allowed-tools: mcp__cross-session-memory__bridge_handoff_summary, mcp__cross-session-memory__bridge_sync_turn, mcp__cross-session-memory__create_checkpoint
---

Prepare a handoff $ARGUMENTS.

1. Resolve `projectRoot` to the current workspace root.
2. If the current state is expensive to reconstruct, `create_checkpoint` first.
3. Sync the final durable milestone with `bridge_sync_turn`, then call `bridge_handoff_summary`.
4. Make the handoff concrete: outcome, files changed, verification performed, open risks, and the next action. Never persist secrets or credentials.

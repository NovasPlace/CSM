---
description: Inspect the live self-model and living-state capability snapshot.
argument-hint: [optional focus]
allowed-tools: mcp__cross-session-memory__csm_self_model, mcp__cross-session-memory__csm_living_state_preview
---

Show the CSM self-model $ARGUMENTS.

1. Resolve `projectRoot` to the current workspace root.
2. Call `csm_self_model` for the authoritative live capability state, and `csm_living_state_preview` for the current living-state snapshot.
3. Summarize capabilities, their status/provenance, and anything that looks stale or contradicted by the current workspace.

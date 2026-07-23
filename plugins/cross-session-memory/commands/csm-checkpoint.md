---
description: Create or inspect durable checkpoints of expensive-to-reconstruct state.
argument-hint: [checkpoint label, or "list"]
allowed-tools: mcp__cross-session-memory__create_checkpoint, mcp__cross-session-memory__list_checkpoints, mcp__cross-session-memory__expand_checkpoint_ref
---

Manage CSM checkpoints: **$ARGUMENTS**

1. Resolve `projectRoot` to the current workspace root.
2. If the argument is "list" (or empty), call `list_checkpoints` and summarize recent checkpoints.
3. Otherwise call `create_checkpoint` capturing the current state with the given label — only when that state would be expensive to reconstruct.
4. Use `expand_checkpoint_ref` to inspect a specific checkpoint the user names.

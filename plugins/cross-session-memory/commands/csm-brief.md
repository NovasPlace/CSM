---
description: Build a context brief for the current task from prior sessions.
argument-hint: [task description]
allowed-tools: mcp__cross-session-memory__get_context_brief, mcp__cross-session-memory__bridge_resume_context, mcp__cross-session-memory__csm_reentry_preview
---

Assemble a context brief for: **$ARGUMENTS**

1. Resolve `projectRoot` to the current workspace root.
2. Call `get_context_brief` (and `bridge_resume_context` for a fuller resume) with the task above.
3. If starting cold, add `csm_reentry_preview` to surface the last durable state.
4. Produce a short brief: what was in flight, key decisions, open risks, and the concrete next action. Flag anything that must be verified against the current workspace before trusting it.

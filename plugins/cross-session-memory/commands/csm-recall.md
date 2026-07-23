---
description: Search project memory and assemble focused evidence for the current task.
argument-hint: [topic or question]
allowed-tools: mcp__cross-session-memory__csm_memory_search, mcp__cross-session-memory__csm_memory_context, mcp__cross-session-memory__csm_memory_related, mcp__cross-session-memory__recall_lessons
---

Recall relevant Cross-Session Memory for: **$ARGUMENTS**

1. Resolve `projectRoot` to the absolute root of the current workspace and keep every call scoped to it.
2. Call `csm_memory_search` with the topic above (or the current task if no argument was given).
3. If results are thin, widen with `csm_memory_context` and `csm_memory_related`; pull reusable lessons with `recall_lessons`.
4. Verify every recalled claim against the current files, tests, and user instructions before acting on it — the workspace is the source of truth, not memory.
5. Summarize only the evidence that changes what we do next. Do not dump raw records.

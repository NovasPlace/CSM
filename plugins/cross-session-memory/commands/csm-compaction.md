---
description: Show context pressure and audit compaction behavior.
argument-hint: [optional focus]
allowed-tools: mcp__cross-session-memory__csm_context_pressure, mcp__cross-session-memory__csm_compaction_audit, mcp__cross-session-memory__get_compaction_report, mcp__cross-session-memory__csm_context_budget
---

Show CSM context pressure and compaction health $ARGUMENTS.

1. Resolve `projectRoot` to the current workspace root.
2. Call `csm_context_pressure` and `csm_context_budget` for the current window state.
3. Call `csm_compaction_audit` and `get_compaction_report` to review recent compaction attribution and token accounting.
4. Summarize pressure, headroom, and whether a checkpoint/handoff is advisable before continuing.

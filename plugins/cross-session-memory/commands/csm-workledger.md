---
description: Show the surviving work-ledger entries across sessions.
argument-hint: [optional filter]
allowed-tools: mcp__cross-session-memory__csm_work_ledger_surviving
---

Show the surviving CSM work ledger $ARGUMENTS.

1. Resolve `projectRoot` to the current workspace root.
2. Call `csm_work_ledger_surviving` and summarize the durable work entries that carried across sessions.
3. Highlight anything still open or needing verification against the current workspace.

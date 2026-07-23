---
description: List, set, or update tracked goals for this project.
argument-hint: [goal text, or "list"]
allowed-tools: mcp__cross-session-memory__goal_list, mcp__cross-session-memory__goal_set, mcp__cross-session-memory__goal_update
---

Manage project goals: **$ARGUMENTS**

1. Resolve `projectRoot` to the current workspace root.
2. If the argument is "list" or empty, call `goal_list` and summarize active goals and status.
3. To record a new goal, call `goal_set` with the given text.
4. To change status or details of an existing goal the user names, call `goal_update`.

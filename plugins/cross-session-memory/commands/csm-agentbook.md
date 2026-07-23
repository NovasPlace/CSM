---
description: Read AgentBook state and events, or manage AgentBook rules.
argument-hint: [optional "rules"]
allowed-tools: mcp__cross-session-memory__csm_agentbook_state, mcp__cross-session-memory__csm_agentbook_events, mcp__cross-session-memory__csm_agentbook_rule
---

Show AgentBook $ARGUMENTS.

1. Resolve `projectRoot` to the current workspace root.
2. Call `csm_agentbook_state` for the current state and `csm_agentbook_events` for recent activity.
3. Only manage rules via `csm_agentbook_rule` — a mutation — when the user explicitly asks to add or change an AgentBook rule.

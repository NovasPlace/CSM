---
description: Review belief knowledge, run a belief scan, and preview promotions.
argument-hint: [optional subject filter]
allowed-tools: mcp__cross-session-memory__csm_belief_knowledge, mcp__cross-session-memory__csm_belief_scan_report, mcp__cross-session-memory__csm_belief_promotion_scan, mcp__cross-session-memory__csm_belief_promote
---

Inspect CSM belief knowledge $ARGUMENTS.

1. Resolve `projectRoot` to the current workspace root.
2. Call `csm_belief_knowledge` (optionally filtered by the argument) and `csm_belief_scan_report` to show current beliefs and scan findings.
3. Use `csm_belief_promotion_scan` to preview which beliefs are promotion-eligible.
4. Only call `csm_belief_promote` — a mutation — when the user explicitly asks to promote a belief. Prefer a dry run first when available.

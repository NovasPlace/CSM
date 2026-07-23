---
description: Preview re-entry context and onboarding for resuming work.
argument-hint: [current task]
allowed-tools: mcp__cross-session-memory__csm_reentry_preview, mcp__cross-session-memory__csm_onboard_agent, mcp__cross-session-memory__csm_continuity_report
---

Preview CSM re-entry for: **$ARGUMENTS**

1. Resolve `projectRoot` to the current workspace root.
2. Call `csm_reentry_preview` and `csm_continuity_report` to surface the last durable state and continuity health.
3. If onboarding context is insufficient, call `csm_onboard_agent` with the current task.
4. Verify recalled state against the workspace before acting on it.

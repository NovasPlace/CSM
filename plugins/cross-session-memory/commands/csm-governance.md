---
description: Run memory governance — dedup detection, candidate and archive reports, merges.
argument-hint: [optional focus]
allowed-tools: mcp__cross-session-memory__csm_memory_governance_report, mcp__cross-session-memory__csm_memory_dedup_detect, mcp__cross-session-memory__csm_memory_candidate_report, mcp__cross-session-memory__csm_memory_archive_candidate_report, mcp__cross-session-memory__csm_memory_merge
---

Run CSM memory governance $ARGUMENTS.

1. Resolve `projectRoot` to the current workspace root.
2. Start read-only: `csm_memory_governance_report`, `csm_memory_dedup_detect`, `csm_memory_candidate_report`, and `csm_memory_archive_candidate_report`.
3. Present the findings and a recommended plan first.
4. Treat `csm_memory_merge` as a mutation — perform merges (exact-match, superseding, never deleting originals) only when the user explicitly approves the specific candidates. For deep governance work, consider delegating to the `csm-archivist` agent.

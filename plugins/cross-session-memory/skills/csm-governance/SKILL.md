---
name: csm-governance
description: Safely deduplicate, review, merge, and archive Cross-Session Memory. Use when memory needs cleanup, dedup, merge, archive-candidate review, or recall-quality assessment.
---

# CSM Memory Governance

Keep project memory clean without losing provenance. Every governance action is scoped to the current `projectRoot`.

## Always preview first

1. Resolve `projectRoot` to the current workspace root.
2. Run the read-only reports before any change: `csm_memory_governance_report`, `csm_memory_dedup_detect`, `csm_memory_candidate_report`, `csm_memory_archive_candidate_report`, and `csm_recall_quality_report`.
3. Present findings and a concrete plan. Ask for approval on the specific candidates before mutating.

## Mutation rules

- `csm_memory_merge` is exact-match only. It supersedes duplicates and preserves originals; it never deletes. Merge only user-approved candidates.
- `csm_memory_delete`, `memory_cleanup`, candidate approval/rejection, and embedding backfill are mutations. Perform them only on an explicit, specific request — never in bulk from a heuristic.
- Never merge on embedding similarity alone; exact content detection catches the real duplication at current scale.

## Boundaries

- Do not cross project boundaries.
- Never surface or persist secrets, credentials, or sensitive content.
- Memory is evidence and provenance; the current repository state is the source of truth.

For a focused, autonomous pass, delegate to the `csm-archivist` agent.

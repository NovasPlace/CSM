CSM ROUND 3 — ACTIVE-TURN + RECOVERY SAFETY FIXES

This patch is incremental. Apply it only after the first TOOL_REF fix and the follow-up compaction/checkpoint patch already installed.

From the CSM repository root:

  git apply --check .\csm-round3-active-turn-recovery-fixes.patch
  git apply .\csm-round3-active-turn-recovery-fixes.patch

Then verify:

  npm run typecheck
  npm run build
  npm run lint:src

Key fixes:
- Governor audit now works on a clone rather than mutating live messages.
- Active-turn messages remain immutable in the compiler, optimizer, checkpoint-ref rebuild, and emergency distilled-state rebuild.
- The active user boundary is recalculated after prefix replacement.
- No-user-boundary cases fail safe and no longer falsely report a rebuild.
- TOOL_REF originals are stored before mutation; storage failure leaves output raw.
- TOOL_REF IDs use call/part identity and avoid collisions between multiple parts in one message.
- TOOL_REF markers include context_fetch recovery instructions and useful file metadata.
- Error references retain explicit ERROR semantics and pass the quality gate safely.
- Checkpoint capture uses OpenCode callID/state.output/state.error shapes.
- UTF-8 byte limits and stored token counts are calculated from stored content.
- Checkpoint creation is serialized per session; only one active checkpoint is enforced.
- Checkpoint expansion accepts message, part, or tool-call IDs.

Verification in the uploaded repository extraction:
- TypeScript typecheck: pass
- Build: pass
- ESLint src: 0 errors, 7 existing opentui.d.ts warnings
- Focused tests: 46/46 pass

PostgreSQL-backed integration suites were not runnable because PostgreSQL was unavailable at 127.0.0.1:5432. Deterministic checkpoint transaction/schema tests passed.

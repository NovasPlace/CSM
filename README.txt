CSM follow-up compaction and checkpoint safety fixes
===================================================

This bundle is incremental to the earlier active-turn TOOL_REF fix.
Extract it into the CSM repository root, merging src/, test/, and dist/.

Fixed:
- Budget pressure compacted newest protected results first.
- Budget pressure could compact running/pending calls.
- Tiny outputs could be replaced by larger TOOL_REF strings.
- Error tool states received an invalid state.output while the full state.error remained.
- The documented quality gate was measured but never enforced.
- Empty passes left stale getLastResult()/getLastQuality() state.
- Telemetry measured truncated pseudo-raw output instead of actual source content.
- Checkpoint recovery used legacy toolCallId/top-level output instead of OpenCode callID/state.output/state.error.
- TOOL_REF markers inside tool state were omitted from checkpoint compacted references.

Apply patch from repository root:
  git apply --check .\csm-followup-compaction-checkpoint-fixes.patch
  git apply .\csm-followup-compaction-checkpoint-fixes.patch

Or extract this ZIP directly into the repository root and overwrite matching files.

Verify:
  npm run typecheck
  npm run build
  npm run lint:src
  node --import tsx --test test/compaction.test.ts test/messages-transform-compaction-safety.test.ts test/checkpoint-opencode-shape.test.ts test/compaction-quality.test.ts test/csm-safety-failure.test.ts test/compaction-analytics.test.ts

Verified in the uploaded repository extraction:
- typecheck: passed
- build: passed
- lint:src: 0 errors, 7 existing baseline warnings
- focused tests: 67/67 passed

PostgreSQL-backed checkpoint integration tests were not run because PostgreSQL was unavailable at 127.0.0.1:5432 in the analysis environment.

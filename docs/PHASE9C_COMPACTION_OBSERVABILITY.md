# Phase 9C — Database-Wide Compaction Observability

**Date:** 2026-07-21  
**Status:** Implemented and migrated; production observation resumes after runtime restart

## Why this pass exists

The previous audit summed `compaction_metrics` without a project filter, but the
rows did not identify their project, client, or runtime. A database-wide total
therefore looked global while offering no proof that all projects or sessions
were represented. Cache persistence and compaction also shared one error path,
so a recoverability-store failure was reported as a generic compaction failure.

## Pre-change production baseline

The live audit captured before this pass reported:

- 390 metric rows
- 1 distinct session (`ses_0822…`)
- 0 successful compressions
- 232 `skipped_under_budget` rows
- 158 failed rows
- 4,107,005 estimated tokens before
- 4,107,005 estimated tokens after
- 0 gross tokens saved

This is an observation baseline, not evidence that CSM cannot save tokens. It
shows that production coverage and failure classification were insufficient to
support a savings claim.

## Changes

### Attribution migration

`compaction_metrics` now includes:

- `project_id`
- `client_kind`
- `runtime_kind`
- `eligible_parts`
- `persisted_parts`
- `failure_stage`
- `failure_code`
- `failure_message`

Historical `project_id` values are backfilled from `sessions` when possible.
Unknown historical client/runtime provenance remains `unknown`; it is not
invented. Indexes cover project, runtime, and failure diagnostics.

### Safe partial progress

Recoverability remains mandatory: a tool output is replaced with `TOOL_REF`
only after its full redacted source is stored in `context_cache`. Cache writes
are now evaluated independently. If one write fails, that output stays raw while
successfully stored candidates remain eligible for compaction.

Failed compactor runs record non-zero before/after snapshots when input was
available. Cache failures and quality-gate rejections receive distinct stage and
code diagnostics.

### Audit semantics

The audit is explicitly database-wide for the selected CSM database. It reports:

- sessions with telemetry / total sessions
- projects represented in `sessions`
- unattributed historical rows
- per-project/client/runtime totals
- classified failure groups
- gross compaction savings
- matched-session production context-injection overhead
- net matched-session savings (`gross - matched overhead`)
- database-wide injection overhead kept separate when compaction-session coverage
  is incomplete

Benchmark percentages remain separate from production measurements.

## Observation protocol

After the updated runtime starts and applies the migration:

1. Run fresh Codex and OpenCode sessions in at least two project folders.
2. Confirm each session appears in `sessions` with its project id.
3. Confirm eligible compaction paths write attributed metrics.
4. Investigate every new `failed` group by `failure_stage/failure_code`.
5. Treat `quality_gate/quality_rejected` as a safety outcome, not saved tokens.
6. Report gross, overhead, and net totals together.
7. Do not publish a production savings percentage until session coverage is
   broad enough to represent normal work and the attributed rows contain
   successful compressions.

## Verified locally

- TypeScript typecheck and build pass.
- Source lint remains at the locked seven warnings in `opentui.d.ts`.
- SQLite upgrade/backfill is idempotent.
- Database-wide coverage and net accounting tests pass.
- Partial cache-write failure leaves the affected output raw and still compacts
  independently recoverable candidates.
- The complete test suite passes against the configured database.

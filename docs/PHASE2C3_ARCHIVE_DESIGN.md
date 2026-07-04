# Phase 2C.3 Archive Design

## Goal
Design a reversible archive mechanism after reviewing archive candidates, without implementing any write path yet.

## Review Result
- `low_access` stays excluded. The Phase 2C.1 review already showed that low access does not imply low value.
- `tiny_type_specific_junk` reviewed set: 139 of 139 rows.
- `tiny_type_specific_junk` conversation rows: 1.
- `already_superseded_duplicate` sampled: 25 rows.

### Candidate assessment
- `tiny_type_specific_junk`
  - Current set is dominated by tiny episodic edit crumbs like `[modified] index.html`.
  - The single conversation candidate is `"[user] Test message - does this work?"` with low score, no access, and no recall.
  - Review result: safe as a future archive-candidate bucket, but still keep it report-only for now.
- `already_superseded_duplicate`
  - Sampled rows were short procedural completion crumbs and short superseded chat turns already replaced by canonical survivors.
  - Review result: safe first archive-apply bucket.

## Proposed archive fields
Archive should be modeled as reversible metadata on `memories`, not deletion.

- `archived_at TIMESTAMPTZ NULL`
  - When the row was archived.
- `archive_reason TEXT NULL`
  - Candidate reason code such as `already_superseded_duplicate` or `tiny_type_specific_junk`.
- `archive_batch_id TEXT NULL`
  - Shared batch identifier for one archive apply run.
- `archive_source TEXT NULL`
  - Tool or script source, for example `phase2c4_archive_apply`.
- `archive_note TEXT NULL`
  - Optional operator note or evidence reference.

### Suggested indexes
- Partial index on `archived_at` for archived-row queries.
- Partial index on `archive_batch_id` for restore-by-batch operations.

## What archive means
Archive means the row remains in `memories` but is marked with archive metadata.

Archive does not mean:
- delete
- prune
- hard hide from the database
- irreversible mutation

Future runtime behavior changes, if any, should be a separate phase after archive metadata exists and is validated.

## Restore strategy
Restore must be batch-based and reversible.

### Restore operation
- Input: `archive_batch_id`
- Action: clear `archived_at`, `archive_reason`, `archive_batch_id`, `archive_source`, and `archive_note`
- Scope: only rows tagged by that batch id
- Safety: run in one transaction

### Restore guarantees
- Never delete rows
- Never rewrite content
- Never alter supersession metadata during restore

## First apply scope
The first write-capable archive phase should be intentionally narrow.

### Include
- `already_superseded_duplicate` only

### Exclude
- `tiny_type_specific_junk`
- `low_access`
- active non-superseded substantive memories
- medium-band conversation memories

### Apply contract
- dry-run by default
- require `--apply` to write
- emit `archive_batch_id`
- emit JSON/TXT evidence with before/after counts
- store the exact reason code written to each row
- perform writes in a transaction

## Non-goals for the first apply phase
- no delete path
- no prune path
- no recall or ranking changes
- no automatic action on `tiny_type_specific_junk`
- no action on `low_access`

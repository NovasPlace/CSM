# Work Journal Reliability Contract

## Original failure modes

The background work-journal writer requeued failed rows but resolved `flush()` successfully. Session
shutdown could therefore continue as if the journal were durable even when the database rejected the
write. The previous chained-promise design could also retain a rejected chain or allow a later captured
batch to overtake a requeued row.

SQLite exposed a separate capability mismatch. Work-journal configuration and runtime hooks remained
enabled, but the SQLite migration manifest did not create `agent_work_journal`. The first journal write
failed at runtime with `SQLITE_ERROR: no such table: agent_work_journal`.

## Corrective behavior

- One serialized drain owns the in-memory buffer. Entries appended during a drain are persisted before
  that drain resolves.
- A failed insert requeues only the uncommitted suffix in original order and rejects `flush()`.
- The next explicit flush can retry; a completed prefix is not repeated by the journal writer.
- Session-end persistence propagates failure instead of reporting false success.
- A session-end marker remains keyed for the journal instance after enqueue, so lifecycle retry cannot
  enqueue a duplicate even when a later buffered row causes the shared drain to reject.
- Ordinary `session.updated` events record checkpoints only; the durable session-end marker is owned by
  disposal rather than fabricated during an active session.
- Timer and threshold-triggered flush failures are recorded through structured logging.
- Read failures remain a safe empty-result degradation but are now observable through structured logs.
- Project-scoped resume never falls back to another project. Prior sessions are selected by latest
  journal activity, and tied entries replay deterministically by descending row identifier.
- PostgreSQL timestamps and timezone-less SQLite UTC text timestamps are normalized to equivalent
  JavaScript `Date` values.
- Circular objects and bigint tool arguments receive a bounded deterministic preview instead of
  aborting capture during serialization.
- SQLite migration `20260711-002-sqlite-work-journal` adds the table and indexes without altering the
  legacy SQLite baseline artifact. PostgreSQL continues to store `files_touched` as `TEXT[]`; SQLite
  stores the same logical string array as JSON text and decodes it on read.

## Regression evidence

`test/agent-work-journal.test.ts` covers partial failure, ordered retry, session-end rejection, and
entries appended during an active flush. `test/agent-work-journal-integration.test.ts` uses a real
temporary PostgreSQL database and a persistent SQLite file, closes and reopens each backend, and proves
the journal entry and file list survive restart. `test/sqlite-schema-bootstrap.test.ts` proves a
baseline-only SQLite ledger applies the additive work-journal migration once. SQLite plugin lifecycle
coverage confirms startup and disposal still operate through the supported adapter path.

## Remaining limitation

The journal provides ordered at-least-once retry within one process. It does not persist its in-memory
buffer before a process crash; only rows whose database insert completed are restart-durable.

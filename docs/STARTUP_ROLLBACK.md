# Startup Rollback Contract

Plugin registration owns every resource it creates until the complete public `Hooks` object has been
assembled. A startup error before that ownership transfer triggers exhaustive reverse-order rollback.

## Original failure mode

The plugin connected the database and started background services before all constructors, hook
factories, and tool registration had succeeded. A later synchronous error rejected registration
without returning a `dispose` hook, leaving the pool, timers, stats writer, lifecycle jobs, or Work
Ledger leases live and unreachable.

## Corrective behavior

- Database close is registered immediately after connection.
- Work Ledger, stats, watcher, and lifecycle cleanup callbacks are registered before later fallible
  startup work.
- Hook factories and `registerTools()` execute inside the startup ownership boundary.
- Context Recall does not launch its asynchronous initial PostgreSQL build until hook assembly has
  succeeded; it is the final startup action before ownership commits.
- Rollback runs every cleanup in reverse dependency order. Cleanup failures are aggregated with the
  original startup error instead of replacing it or stopping later cleanup.
- Normal disposal retains its separate retry-only-failed behavior after successful startup.

## Verification evidence

`test/plugin-startup-rollback.test.ts` injects failures immediately after real SQLite connection and
after all SQLite services start. Its PostgreSQL case creates a real temporary database, opens a
pending Work Ledger capture, fails hook activation, asserts exact cleanup order, confirms the pool is
closed, and reacquires the same file lease with a new ledger.

## Codex bridge ownership boundary

`CodexMemoryBridge.connect()` uses its own startup ownership boundary. A failure after database
connection or during final bridge activation disposes Work Ledger leases before closing the database.
Successful activation transfers both resources to a lifecycle controller.

Bridge shutdown closes operation admission synchronously, waits for already admitted operations,
then disposes the Work Ledger before the database. Concurrent disconnect calls coalesce. A failed
cleanup can be retried without repeating completed steps. Once shutdown begins, data and Work Ledger
operations fail with an explicit bridge lifecycle error; after closure `listTools()` returns no
capabilities while `getDatabaseUrl()` remains available for diagnostics.

`test/codex-bridge-lifecycle.test.ts` covers SQLite startup rollback, real PostgreSQL activation
rollback with a pending lease, cleanup ordering and retry, concurrent disconnect, admitted-operation
drain, Work Ledger capture drain, rejection during and after closure, and post-close capability state.

The plugin-registration slice passed its second independent review cycle. The Codex bridge slice is
documented here after implementation and full-gate verification; its independent re-review result is
reported separately rather than presumed by this document.

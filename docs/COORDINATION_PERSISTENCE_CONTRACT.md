# Coordination Persistence and Event Contract

**Status:** Phase 2 implementation contract.

## Boundary

- Coordination persistence is PostgreSQL-only.
- Legacy CSM SQLite support remains unchanged.
- SQLite must reject Coordination persistence construction before issuing SQL.
- No hooks, tools, UI, agent spawning, or micro-app runtime are introduced in Phase 2.

## Durable records

Phase 2 adds:

```text
coordination_workspaces
coordination_agents
coordination_assignments
coordination_dependencies
coordination_resource_claims
coordination_findings
coordination_deliverables
coordination_handoffs
coordination_approvals
coordination_verifications
coordination_events
coordination_idempotency_keys
```

All tables are workspace-scoped, foreign-key constrained, and indexed for their expected read paths. Structured fields use `JSONB`. State and version columns use database checks matching the Phase 1 domain contract.

Database triggers additionally enforce the primary-agent role, serialize conflicting resource claims with advisory locks, match inserted event sequences to the workspace counter, and reject event mutation.

## Transactions

Workspace creation atomically inserts the workspace, its primary agent, the creation event, and the idempotency result.

Assignment creation atomically:

1. Locks the idempotency key and workspace.
2. Confirms the primary actor and expected workspace version.
3. Inserts the assignment and dependencies.
4. Increments the workspace version.
5. Appends the ordered creation event.
6. Records the replay result.

Assignment completion atomically:

1. Locks the idempotency key, workspace, and assignment.
2. Confirms expected versions and primary authority.
3. Validates required, evidenced verification results.
4. Inserts verification records.
5. Persists `review -> verified` and then `verified -> completed` with separate version increments.
6. Requires an unexpired approval bound to `assignment.complete`, risk, workspace, assignment, and current assignment version when user approval is required.
7. Releases active claims.
8. Marks newly unblocked dependents ready.
9. Appends full verification, completion, released-claim, and readiness event evidence.
10. Records the replay result.

Any failure rolls back every state, event, version, claim, and idempotency write in the operation.

## Idempotency

- Keys are scoped to a workspace.
- Operations acquire a transaction-scoped PostgreSQL advisory lock before lookup.
- The stored request hash must match on replay.
- A matching replay returns the stored result without repeating state or events.
- Reusing a key for a different operation or request fails explicitly.

## Events

- Events are append-only.
- Each workspace owns a monotonic `event_sequence` counter.
- `(workspace_id, sequence)` is unique.
- Update and delete attempts are rejected by a PostgreSQL trigger.
- Event payloads must already satisfy the Phase 1 recursive JSON contract.
- Mutation events carry the durable entity or exact affected identifiers and resulting versions needed to reconstruct state transitions.

## Read models

- Workspace reconstruction runs in a PostgreSQL repeatable-read, read-only transaction.
- Agents, assignments, claims, and events therefore come from one consistent snapshot.
- Every collection is bounded to at most 1,000 rows per request.
- The response reports a `hasMore` signal for each bounded collection.
- Ordered event pagination uses an exclusive sequence cursor.

## Recovery and compatibility

- Migration 22 is additive and rerunnable through the migration ledger.
- Existing PostgreSQL databases upgrade without changing prior records.
- Restart reads durable workspace state and ordered events without replaying mutations.
- Rollback is forward repair; dropping audit-bearing tables is not an automatic rollback action.

## Phase 2 non-goals

- Public coordination tools
- Host hook integration
- Agent heartbeats or context packet delivery
- Automatic claim acquisition
- Approval execution
- Micro-app persistence or actions

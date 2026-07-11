# Coordination State Machines

**Status:** Phase 0 contract for pure Phase 1 transitions.

## Assignment states

```text
queued -> ready -> assigned -> active -> review -> verified -> completed
                                 |         |
                                 v         +-> active
                              blocked -> active

queued, ready, assigned, active, blocked -> cancelled where allowed
active, blocked, review -> failed
```

Allowed transitions:

| From | To |
|---|---|
| queued | ready, cancelled |
| ready | assigned, cancelled |
| assigned | active, cancelled |
| active | blocked, review, failed, cancelled |
| blocked | active, failed, cancelled |
| review | active, verified, failed |
| verified | completed |
| completed, failed, cancelled | none |

Guards:

- `queued -> ready`: all dependencies are completed.
- `ready -> assigned`: `assignedAgentId` exists.
- `active -> blocked`: a structured blocker was submitted.
- `active -> review`: required deliverables were submitted.
- `review -> verified`: required verification passed.
- `verified -> completed`: the primary agent accepted the work and required user approval was granted.
- A repeated request for the current state is idempotent.
- Every other consequential transition must match the current version and increments it once.

## Workspace states

| From | To |
|---|---|
| planned | active, cancelled |
| active | paused, completed, cancelled |
| paused | active, cancelled |
| completed, cancelled | none |

Workspace transitions update `updatedAt`, increment `version`, and set `completedAt` only on completion. Timestamps are supplied by the caller so domain behavior stays deterministic.

## Claim states

```text
active -> released
active -> expired
active -> conflicted
```

Phase 1 does not persist transitions. It calculates overlap, containment, expiry, usability, and conflict outcomes. An exclusive claim conflicts with every different overlapping active claim, including claims owned by the same agent for another assignment. Only a semantically identical claim record is an idempotent replay; reusing its id with altered ownership, assignment, scope, mode, status, or lease fails. Overlapping write claims conflict; read claims may coexist with non-exclusive writes.

## Approval states

```text
pending -> approved | rejected | expired | revoked
approved -> revoked
```

Phase 1 validates shape and expiry only. Later persistence must make decisions immutable events and reject stale or replayed actions.

## Dependency rules

- Dependencies and readiness status lookups are qualified by workspace.
- Self-dependencies and cycles are invalid.
- An assignment becomes ready only when every referenced prerequisite is `completed`.
- Adding a duplicate edge is idempotent.

## Failure semantics

Invalid transitions and guard failures throw stable `CoordinationDomainError` codes without mutating input. No Phase 1 function performs I/O or partially applies state.

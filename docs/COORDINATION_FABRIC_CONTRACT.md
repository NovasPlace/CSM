# CSM Coordination Fabric Contract

**Status:** Accepted Phase 0 contract.
**Scope:** Phase 0 and Phase 1 only.

## Purpose

The Coordination Fabric is a persistent, auditable control layer for one authoritative primary agent and bounded subordinate agents. Phase 1 supplies only a pure deterministic domain model. Persistence, tools, hooks, spawning, and UI integration are later phases.

## Constitutional invariants

1. Each workspace identifies exactly one primary agent.
2. Only the primary agent can assign work; subordinate agents request scope changes instead.
3. A subordinate agent cannot mutate the canonical plan without an accepted proposal.
4. Writes require an active claim inside the assignment's allowed resources.
5. High-risk actions require the configured approval.
6. Every assignment has an owner or explicit unassigned state, objective, scope, status, and completion criteria.
7. Required verification has at least one required criterion, evidence, and a completion timestamp.
8. Consequential transitions use optimistic versions and are idempotent on retry.
9. Coordination state and future events remain workspace- and project-scoped.
10. Feature-disabled CSM behavior remains unchanged.

## Provider boundary

- Legacy CSM continues to support PostgreSQL and SQLite.
- Coordination Fabric is PostgreSQL-only.
- Enabling Coordination Fabric or Micro-App Runtime with SQLite fails closed.
- Phase 0 and Phase 1 create no tables and run no persistence operations.
- Future persistence must use raw parameterized PostgreSQL SQL through the existing CSM database abstraction.

## Feature flags

```text
coordination.enabled     default false
microapps.enabled        default false; requires coordination.enabled
microapps.allowActions   default false; requires microapps.enabled
```

Environment bindings are `CSM_COORDINATION_ENABLED`, `CSM_MICROAPPS_ENABLED`, and `CSM_MICROAPPS_ALLOW_ACTIONS`. Only literal `true` and `false` are accepted. The flags are configuration contracts only in Phase 0/1; no current hook or tool consumes them.

## Phase 0/1 implementation boundary

Allowed:

- Contracts, threat model, and state-machine documentation
- Disabled configuration flags
- Pure TypeScript types, validators, errors, graph logic, claim calculations, and state transitions
- Focused unit tests

Forbidden in this slice:

- Database migrations or schema initialization
- Coordination stores, event writers, or read models
- Tool or hook registration
- Agent spawning or orchestration
- Micro-app rendering or runtime bridge
- Changes to existing CSM behavior

## Existing architecture inventory

| Surface | Existing abstraction | Phase 0/1 treatment |
|---|---|---|
| Legacy configuration | `src/config.ts`, `src/provider-runtime-config.ts`, `PluginConfig` | Unchanged in Phase 0/1 |
| Experimental flags | `src/coordination-feature-config.ts` | Standalone disabled contract; runtime wiring deferred |
| Persistence | `Database`, `DatabasePool`, migration ledger, provider adapters | No imports from domain package |
| Events | `src/hooks/event-hooks.ts` | No integration |
| Tools | `src/tools.ts`, tool hooks, Codex bridge | No registration |
| Continuity | re-entry, checkpoints, work journal, Work Ledger | No behavioral changes |
| UI | optional TUI adapter | Not a micro-app runtime; unchanged |
| Audit | migration ledger and PostgreSQL Work Ledger | Reused only in future phases |

## Baseline and checkpoint

- Repository checkpoint: `dbcec227c628f9f5e8065ef8c475c95955e6b6e2` on `master`.
- The working tree was intentionally non-clean before Phase 0; unrelated edits remain out of scope.
- Independent pre-Phase-0 gate: 1,022 tests passed, 0 failed, 0 skipped.
- Typecheck and production build passed.
- Lint passed its locked baseline with 0 errors and 7 external declaration warnings.
- PostgreSQL backup/restore drill passed with zero record loss and cleanup confirmation.

## Phase 1 acceptance

- Pure deterministic domain layer with no database or host-runtime imports
- Valid and invalid transitions covered
- Dependency cycles rejected
- Dependency readiness remains workspace-scoped
- Claims and assignment scopes checked deterministically
- Approval expiry, handoff completeness, verification, and versions enforced
- Malformed payloads rejected
- Event payloads and action previews are recursively JSON-serializable
- At least 60 focused tests
- Complete existing enterprise gate remains green

## Rollback

Keep all three flags disabled. Because Phase 0/1 has no runtime consumers or persistence, rollback is removal of the new pure package, tests, documentation, and configuration fields; no data repair is required.

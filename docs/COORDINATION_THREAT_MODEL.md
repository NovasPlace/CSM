# Coordination Fabric Threat Model

**Status:** Phase 0 baseline. Controls are contractual until their implementation phase.

## Protected assets

- Canonical workspace plan and primary-agent authority
- Assignment scope, dependencies, and status
- Resource claims and ownership
- Handoffs, findings, evidence, and verification results
- Approvals and user decisions
- Event history and future audit exports
- Workspace, project, and micro-app isolation
- Existing CSM memories and continuity state

## Trust boundaries

```text
User / primary agent
  -> host tool boundary
  -> Coordination Fabric services
  -> PostgreSQL transaction and event boundary
  -> read-model boundary
  -> micro-app bridge
  -> untrusted rendered/generated content
```

Sub-agent output, task text, findings, evidence labels, generated manifests, micro-app messages, and replayed events are untrusted input.

## Threats and required controls

| Threat | Required control |
|---|---|
| Forged primary identity | Workspace-bound identity and exactly-one-primary invariant |
| Scope expansion | Assignment resource allowlist and active-claim enforcement |
| Conflicting writes | Transactional claims, overlap checks, leases, and conflict events |
| Invalid state mutation | Pure allowlisted state machines and expected versions |
| Dependency manipulation | Workspace-scoped acyclic graph validation |
| Verification bypass | Required criteria gate before completion |
| Approval spoofing | Immutable request identity, expiry, attribution, and risk policy |
| Replay | Idempotency keys, nonces, and recorded outcomes |
| Cross-workspace access | Workspace/project predicates on every future query and action |
| Prompt or stored injection | Treat content as data; sanitize UI output; no instruction execution |
| Capability escalation | Deny-by-default capability policy; apps cannot self-expand |
| Event tampering | Append-only events and integrity checks where practical |
| Oversized payload denial | Schema, depth, count, and byte limits at boundaries |
| Unserializable audit payload | Recursive JSON compatibility validation before event or action acceptance |
| Network exfiltration | Micro-app network deny-by-default and explicit allowlists |
| Compromised sub-agent | Bounded assignment, claims, handoff review, independent verification |

## Phase 0/1 security posture

- Features are disabled by default.
- SQLite enablement fails closed because Coordination Fabric is PostgreSQL-only.
- The domain package imports no database, host, network, filesystem, or tool modules.
- Validators reject malformed structural input.
- State machines are deterministic and do not perform effects.
- No runtime attack surface or persistent coordination state is introduced.

## Deferred controls

Authentication, authorization matrices, persistent idempotency, nonce storage, rate limits, event integrity, bridge origins, CSP, sanitization, and manifest integrity belong to later phases. Their absence is safe only because Phase 0/1 registers no runtime or mutation surface.

## Emergency posture

All three feature flags remain false. Future phases must preserve independent disable switches for Coordination Fabric, micro-app rendering, and micro-app actions.

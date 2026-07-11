# CSM Micro-App Runtime Contract

**Status:** Accepted contract; runtime implementation deferred beyond Phase 1.

## Role

A micro-app is a generated interface over persisted Coordination Fabric state. It is never the source of coordination truth and never receives direct database, filesystem, shell, network, or unrestricted tool access.

## Activation

- `microapps.enabled` defaults to `false` and requires `coordination.enabled`.
- `microapps.allowActions` defaults to `false` and requires `microapps.enabled`.
- No Phase 0/1 runtime code reads these flags.
- Disabling micro-apps must leave coordination state usable through non-UI surfaces.

## Authority boundary

Micro-apps may eventually:

- Read a workspace-scoped projection supplied by a trusted bridge
- Render approved components
- Request explicitly declared actions
- Persist bounded state according to a manifest

Micro-apps may never:

- Query CSM databases directly
- Invoke host tools directly
- Expand their capabilities or data sources
- Change workspace identity
- Treat rendered or generated content as trusted instructions
- Execute arbitrary generated JavaScript in the first implementation generation

## Declarative first generation

The first runtime must use a validated manifest, approved components, declared data bindings, declared actions, and explicit input/state/output schemas. Unknown components, undeclared sources, undeclared actions, and network access fail closed.

## Future action boundary

Every requested mutation must carry:

```text
action id
micro-app id
workspace id
action type
validated payload
expected version
idempotency key
request timestamp
nonce
```

Action previews and future event payloads must be recursively JSON-compatible before they can cross a persistence or audit boundary.

The trusted bridge validates origin, identity, schema, capability, workspace, version, replay state, risk policy, and approval before routing a transaction. The micro-app only requests; the Coordination Fabric decides and records the outcome.

## Isolation and integrity

- Every projection and action is workspace-scoped.
- Bridge origin is allowlisted and bound to the micro-app identity.
- Manifest and snapshot size are bounded.
- Stored labels and Markdown are sanitized before rendering.
- Network policy is deny-by-default.
- State versions are explicit and migrations are validated.
- Restart restores only integrity-checked state.

## Phase 0/1 non-goals

There is no renderer, registry, generator, bridge, action router, package, UI, schema, or persistence in this slice. The contract exists to prevent the pure Coordination domain from silently acquiring UI authority later.

# Contributing to CSM

Cross-Session Memory is a continuity runtime with database, retrieval, lifecycle-hook, and governance contracts. Changes should preserve those contracts rather than optimizing one path in isolation.

## Before you begin

Read:

- [README.md](README.md)
- [docs/FEATURES.md](docs/FEATURES.md)
- [docs/PRODUCT_ARCHITECTURE.md](docs/PRODUCT_ARCHITECTURE.md)
- [SECURITY.md](SECURITY.md)

For historical rationale, consult the relevant phase document in `docs/`.

## Development setup

```bash
git clone https://github.com/NovasPlace/CSM.git
cd CSM
npm install
```

Configure a database before running database-sensitive commands.

### PostgreSQL

```bash
export CSM_DATABASE_PROVIDER=postgres
export CSM_DATABASE_URL=postgres://user:password@localhost:5432/csm
npm run db:setup
```

### SQLite

```bash
export CSM_DATABASE_PROVIDER=sqlite
export CSM_SQLITE_PATH=.data/csm.sqlite
npm run db:setup
```

PostgreSQL is the full feature path. SQLite is an intentionally smaller local-core provider.

## Branch and change discipline

- Start from the current `master`.
- Use one focused branch per change.
- Keep unrelated cleanup out of functional fixes.
- Preserve meaningful commit boundaries when a change has independently reviewable prerequisites.
- Do not commit secrets, database dumps, local paths, generated logs, or private memory content.
- Avoid rewriting migration history that may already have been applied.

Suggested branch prefixes:

- `feat/`
- `fix/`
- `docs/`
- `test/`
- `chore/`

## Required gates

Run the relevant focused tests while developing. Before requesting merge, run:

```bash
npm run typecheck
npm run build
npm run lint:src
npm test
```

For PostgreSQL, migration, persistence, or reliability changes, also run:

```bash
npm run db:setup
npm run drill:backup-restore
```

The combined enterprise gate is:

```bash
npm run verify:enterprise
```

A passing focused test is not a substitute for the full suite when shared runtime code, hooks, storage, schema, or tool registration changes.

## Database changes

Database work must address both schema state and runtime behavior.

### PostgreSQL

- Add a forward-only migration.
- Keep migration ordering deterministic.
- Preserve migration-ledger integrity.
- Test fresh initialization and upgrades from an existing schema.
- Use explicit transaction and locking behavior where concurrency matters.
- Include backup/restore evidence for changes that affect durable data.

### SQLite

- Update the SQLite schema/bootstrap contract when the feature is supported.
- Keep initialization idempotent.
- Test fresh databases and existing databases.
- Do not claim provider parity without implementation and contract tests.

### Provider boundaries

When a feature is PostgreSQL-only:

- document the limitation
- remove or guard the tool for SQLite
- add a test proving the provider surface is honest
- avoid leaving a visible tool that fails only after invocation

## Tool changes

New or changed tools should include:

- a clear description
- bounded and validated arguments
- explicit result metadata
- provenance or source evidence where applicable
- provider support rules
- failure behavior
- focused tests
- registration in the correct composition surface
- updates to `docs/FEATURES.md`

If a tool affects re-entry, governance, promotion, deletion, or compaction, document the safety boundary and preview behavior.

## Hook changes

Lifecycle hooks are high-blast-radius code.

Verify:

- project and session isolation
- cleanup and disposal
- concurrent execution
- fail-open or fail-closed behavior
- source attribution
- workspace path correctness
- no duplicate registration
- no stale module-level state across sessions

Prefer project-keyed state over process-global latches.

## Memory and governance changes

Memory behavior must remain auditable.

- Preserve provenance.
- Avoid destructive deduplication when supersede or merge is sufficient.
- Keep derived state separate from source evidence.
- Mark direct, inferred, and missing evidence honestly.
- Bound retrieval and injection.
- Keep promotion revisable.
- Add regression tests for false-positive and false-negative behavior.

## Documentation changes

Update the canonical documentation in the same change:

| Change | Required documentation |
|---|---|
| New user-facing feature | `README.md` and `docs/FEATURES.md` |
| Runtime or data-flow change | `docs/PRODUCT_ARCHITECTURE.md` |
| New environment variable | `README.md` configuration table |
| Provider support change | README database matrix and feature map |
| Migration or contract change | Relevant phase/contract document |
| Security-sensitive behavior | `SECURITY.md` |

Generated operational documents are not substitutes for product documentation.

## Pull requests

A pull request should explain:

1. the problem
2. the root cause
3. the exact scope
4. the behavior change
5. provider and migration impact
6. verification performed
7. risks and rollback strategy
8. documentation updated

Attach raw failure output or CI links when fixing a regression. Do not summarize a failed gate as passing.

## Review standard

Reviewers should be able to determine:

- whether the change solves the stated problem
- whether it introduces hidden provider differences
- whether persistent data remains recoverable
- whether context remains bounded
- whether derived claims retain evidence
- whether concurrent sessions and projects remain isolated
- whether tests cover the failure family rather than one example

## Security reports

Do not disclose vulnerabilities or sensitive memory contents in a public issue. Follow [SECURITY.md](SECURITY.md).

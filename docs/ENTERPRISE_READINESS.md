# Enterprise Readiness

## Status

CSM is in enterprise hardening, not enterprise certified. The current baseline has strong runtime and integration evidence, while the production operations, security, scale, and release gates below remain open.

## Proven Baseline

As of 2026-07-18, the isolated commercial release gate proves:

- TypeScript build and typecheck pass.
- 1,787 of 1,787 tests pass against a fresh isolated PostgreSQL database plus real SQLite paths.
- Source lint passes with zero errors and seven locked external-declaration warnings.
- PostgreSQL schema startup is transaction-bound, advisory-lock serialized, and fail-fast.
- Schema step failures report the exact failed initializer and roll back the transaction.
- PostgreSQL and SQLite record immutable migration identifiers and SHA-256 checksums over their contracts and executable migration artifacts. Verification hashes recognized UTF-8 text with canonical LF line endings, rejects mixed or bare-CR forms, and keeps binary artifacts byte-exact.
- Startup rejects checksum drift, unknown future migrations, and cross-provider history.
- Every unapplied required migration is fail-fast, including ownership failures.
- Real PostgreSQL tests prove transaction rollback after DDL failure and concurrent-startup serialization.
- A real PostgreSQL legacy-schema upgrade preserves data and replays idempotently.
- An isolated custom-format dump/restore drill validates migration history, sentinel data, and cleanup.
- The drill is scale-configurable, emits machine-readable timing/RPO evidence, and enforces optional RTO and data-loss thresholds.
- A local PostgreSQL 16 run restored and validated 50,000 memories in 1,337.02 ms with 0 records lost and cleanup verified.
- The supported schema window is explicit and tested: legacy-unversioned to PostgreSQL v2, PostgreSQL v1 to v2, PostgreSQL v2 replay, and SQLite v1 replay.
- PostgreSQL v2 adds a run-level Work Ledger with model/tool/file hashes, deterministic survival status, bidirectional supersession lineage, automatic OpenCode capture, and an explicit Codex bridge adapter.
- Backup tools must match the PostgreSQL server major version before the drill creates databases.
- The CI matrix uses pinned pgvector images for PostgreSQL 14 and 16 and runs the drill with matching client tools on both.
- SQLite exposes only its supported core-memory capabilities.
- PostgreSQL-only services are disabled or rejected explicitly in SQLite mode.
- Disposal waits for queued statistics and work-journal writes before disconnecting.
- Fresh-schema PostgreSQL tests and a real SQLite plugin lifecycle probe run in the suite.
- PostgreSQL pool size, connection/statement/idle timeouts, and TLS enforcement policy are validated configuration.
- `Database.diagnose()` exposes machine-readable startup, liveness, readiness latency, failure reason, provider, and pool state.
- The npm artifact uses an explicit allowlist, excludes workspace/generated state, and has an executable dry-run boundary test.
- The customer database setup command runs from compiled JavaScript and is smoke-tested against a fresh SQLite database.
- The packaged `csm-doctor` command emits human or support-safe JSON diagnostics, checks Node/configuration/security/database/schema readiness, verifies the complete migration ledger, and leaves a missing SQLite database uncreated.
- Customer memory, transcript, onboarding, AgentBook event/state, recall-quality, governance, export, and lifecycle surfaces are bound to the registered project, with adversarial two-project regression tests. Installation-level state is explicitly documented and is not presented as multi-tenant isolation.
- The full release gate verifies the package boundary, zero-loss backup/restore, production dependency audit, reviewed licenses, CycloneDX SBOM, pinned CI actions, and secret-policy controls before removing its disposable database.

These results establish a reliable engineering baseline. They do not establish production certification, a security attestation, or a service-level commitment.

## Open Enterprise Gates

### Data and Migrations

- Repeat the 50,000-record timing drill on production-equivalent infrastructure and ratify operational RPO/RTO thresholds.

### Availability and Performance

- Define service-level indicators and objectives for startup, recall latency, write latency, and failed persistence.
- Add concurrent startup, load, soak, and fault-injection tests with published limits.

### Observability

- Export structured metrics and traces for schema startup, search, writes, queues, and shutdown flushes.
- Add alerts for persistence failures, queue backlog, slow queries, schema drift, and embedding-provider degradation.
- Define log retention, redaction, correlation identifiers, and operator escalation procedures.

### Security and Governance

- Complete threat modeling and an independent security review.
- Define authentication, authorization, tenant isolation, retention, deletion, and audit policies.
- Document encryption requirements for transport, storage, backups, and secrets.
- Keep dependency vulnerability scanning, exact-fingerprint secret scanning, production-license review, and CycloneDX SBOM generation green; commission an independent security review before certification claims.

### Quality and Release Operations

- Generate code coverage in CI and enforce justified thresholds. CI currently does not generate coverage.
- Complete release versioning automation and verify the first protected npm staged-publish run. The package boundary, compatibility policy, support matrix, rollback criteria, SBOM, immutable CI action references, signed GitHub attestations, and npm trusted-publishing workflow are documented and executable.
- Resolve or formally ratify legacy file-size debt in touched runtime modules.
- Run an independent final review of persistence and migration behavior before a certification claim.

## Milestone Order

1. Completed: database transport controls plus readiness and liveness diagnostics.
2. In progress: production-equivalent backup timing; supported-version upgrade matrix is complete.
3. Metrics, traces, SLOs, load tests, and fault injection.
4. Security controls, tenant boundaries, audit policy, and supply-chain checks.
5. Coverage thresholds, release engineering, independent review, and certification evidence pack.

## Completion Standard

The enterprise goal is complete only when every applicable gate has executable evidence, operator documentation, an owner, and a repeatable CI or drill path. Passing unit and integration tests alone is insufficient.

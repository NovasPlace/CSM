# Architecture Decisions — 2026-07-10

## AD-31: Persistence-provider boundary

**Status:** Accepted and locked for the current implementation phase.

- SQLite remains supported for the legacy CSM execution path.
- Coordination Fabric is PostgreSQL-only.
- Coordination Fabric must not create SQLite schemas, advertise SQLite capabilities, or weaken its PostgreSQL prerequisite.
- Existing SQLite adapters, contracts, and integration coverage remain in place.
- Removing SQLite repository-wide requires a separate, explicitly approved migration/removal phase.

This boundary resolves the apparent conflict between legacy compatibility and the Coordination Fabric persistence contract. Provider capability reporting must distinguish the legacy CSM surface from Coordination Fabric instead of treating either provider as universally capable.

## AD-32: Additional Work Ledger review cycle

**Status:** Authorized once, with narrow scope.

One additional independent Work Ledger review cycle is authorized for:

1. Windows case aliases that refer to the same physical file, including concurrent creation through differently cased names.
2. Unified-diff path parsing, including timestamped headers and quoted or Git-escaped paths.
3. Regressions directly caused by correcting those two findings.

Required closure evidence:

- Focused deterministic tests for both findings.
- Real PostgreSQL Work Ledger integration coverage.
- Legacy SQLite lifecycle/provider-boundary coverage.
- Typecheck, production build, lint, and immutable migration-artifact checks.
- Independent re-review of the resulting narrow diff.

No broader Work Ledger redesign or unrelated provider migration is authorized by this decision.

## AD-33: Cross-platform immutable-artifact hashing

**Status:** Accepted for verification infrastructure.

- Recognized text artifacts are decoded as strict UTF-8 and canonicalized from uniform CRLF to LF before SHA-256 hashing.
- Uniform LF content remains unchanged before hashing.
- Mixed LF/CRLF content and bare carriage returns are rejected as malformed instead of normalized.
- Binary and unrecognized artifact types remain byte-exact.
- Existing expected checksums remain authoritative because they represent committed LF content.
- An LF-only checkout is not required on Windows.

This decision changes verification canonicalization only. It does not alter immutable migration sources or permit expected checksums to be replaced merely to match a platform-specific working tree.

### Compatibility note: evolved pre-ledger migration sources

The migration ledger was introduced after several historical migration sources had already evolved. Existing databases can therefore contain the original artifact-set checksum while the current release executes the later pinned source set.

The historical `sha256` values remain unchanged. A separate `sourceSha256` pins each canonical current source and is included in the checksum recorded by fresh databases. PostgreSQL migrations with an evolved source set explicitly accept the one derived historical migration checksum during upgrade; arbitrary checksums still fail. Tests lock current-source recording, historical compatibility, and source drift detection.

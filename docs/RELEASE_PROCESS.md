# Release Process

CSM is currently source-first and not represented as a generally available hosted service. A release is customer-ready only when the artifact boundary, compatibility evidence, upgrade path, and rollback path are all verified.

## Supported release artifact

The npm artifact contains only:

- compiled runtime and type declarations under `dist/`
- the repo-local Codex/MCP launcher metadata
- the environment example
- the license, security policy, and curated product/operator documentation

It must not contain source tests, temporary diagnostics, generated AgentBook state, local database state, Obsidian metadata, patches, work-in-progress files, or workflow fixtures. `scripts/release-package-stage.mjs` constructs the artifact in a clean temporary directory, and `test/package-release-boundary.test.ts` enforces the contract against that staged npm manifest. This prevents npm's automatic root-document handling from pulling local `README*` notes out of a dirty developer checkout.

## Release gate

From a clean checkout with the supported Node.js version:

```powershell
npm ci
$env:CSM_RELEASE_DATABASE_URL='postgresql://release_user:password@localhost:5432/postgres'
npm run verify:release
npm run package:dry-run
```

On POSIX shells, set the same value with `export CSM_RELEASE_DATABASE_URL=...`.

`verify:release` creates a uniquely named disposable PostgreSQL database, runs the complete build, typecheck, supported test suite, and locked source lint gate against it, then removes it. It supplies the server URL to the PostgreSQL backup/restore drill through a separate environment boundary before running the package-boundary test and compiled SQLite setup smoke test. Never set the release URL to a database account that cannot create and drop isolated databases.

Review the dry-run manifest before publishing. Confirm the version, release notes, supported schema window, and database backup guidance match the candidate artifact. Build the tarball only through `npm run package:create`; do not publish by running `npm publish` from the repository root.

## Installation contract

- Match the current OpenCode plugin runtime: Node.js `^22.22.2`, `^24.15.0`, or `>=26.0.0`.
- `csm-init` and `npm run db:setup` use the compiled runtime, not development-only TypeScript tooling.
- SQLite uses `better-sqlite3`, so normal dependency lifecycle scripts must be allowed to install its native binding.
- PostgreSQL is the complete feature path; SQLite is the documented local core mode.
- Production PostgreSQL deployments must use an explicit database URL and follow `SCHEMA_SUPPORT_MATRIX.md` before an upgrade.

## Publishing

Publish the staged tarball from protected CI after the release gate succeeds. npm provenance is enabled in `publishConfig`; do not publish a locally modified artifact or bypass the manifest review.

Signed release archives, an SBOM, vulnerability scanning, and an independent security review remain open commercial-readiness gates. Do not describe the project as certified until those controls have executable evidence.

## Rollback

Application rollback does not reverse database migrations. Before upgrading, create and verify a database backup. If rollback is required:

1. stop writers;
2. restore the pre-upgrade backup into a new database;
3. point the prior supported CSM version at that restored database;
4. run readiness checks before resuming traffic;
5. deprecate a bad npm release rather than silently replacing its contents.

Never delete migration-ledger rows or manually reverse production DDL in place.

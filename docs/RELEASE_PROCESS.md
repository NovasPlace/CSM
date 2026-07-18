# Release Process

CSM ships as a versioned npm plugin package and is not represented as a generally available hosted service. Source checkout is the contributor path, not the customer installation path. A release is customer-ready only when the artifact boundary, compatibility evidence, upgrade path, diagnostics, and rollback path are all verified.

## Supported release artifact

The npm artifact contains only:

- compiled runtime and type declarations under `dist/`
- compiled `csm-init` and `csm-doctor` customer commands
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

`verify:release` creates a uniquely named disposable PostgreSQL database, runs the complete build, typecheck, supported test suite, and locked source lint gate against it, then removes it. It supplies the server URL to the PostgreSQL backup/restore drill through a separate environment boundary before running the package-boundary test, compiled SQLite setup and read-only doctor smoke tests, production vulnerability and license checks, and CycloneDX SBOM generation. Never set the release URL to a database account that cannot create and drop isolated databases.

Review the dry-run manifest before publishing. Confirm the version, pinned package examples in the README and troubleshooting guide, release notes, supported schema window, and database backup guidance match the candidate artifact. Build the tarball only through `npm run package:create`; do not publish by running `npm publish` from the repository root.

## Installation contract

- Match the current OpenCode plugin runtime: Node.js `^22.22.2`, `^24.15.0`, or `>=26.0.0`.
- `csm-init` and `npm run db:setup` use the compiled runtime, not development-only TypeScript tooling.
- `csm-doctor` and `npm run doctor` validate runtime, configuration, security baseline, connectivity, and the complete migration ledger without mutating storage; `--online` adds one bounded embedding-provider probe.
- SQLite uses `better-sqlite3`, so normal dependency lifecycle scripts must be allowed to install its native binding.
- PostgreSQL is the complete feature path; SQLite is the documented local core mode.
- Production PostgreSQL deployments must use an explicit database URL and follow `SCHEMA_SUPPORT_MATRIX.md` before an upgrade.

## Publishing

Releases are manually dispatched through `.github/workflows/release.yml` from an existing `v<package-version>` tag. The selected workflow ref and the typed release tag must both match `package.json`; the operator must also type the exact `name@version`, and the `npm-production` GitHub environment must approve the job. The job reruns the commercial gate and full-history secret scan, builds one tarball, creates a SHA-256 manifest, signs GitHub build and SBOM attestations, and uploads the candidate.

For a package that already exists on npm, select `stage`. npm trusted publishing must authorize repository `NovasPlace/CSM`, workflow `release.yml`, environment `npm-production`, and the `npm stage publish` action. The workflow submits the exact tarball to npm staging, where a maintainer must inspect and approve it with 2FA before it becomes public.

npm cannot stage a brand-new package. For the one-time bootstrap release, select `candidate-only`, download the attested workflow artifact, verify `SHA256SUMS` and the GitHub attestations, and publish that exact tarball interactively with an owner account and 2FA. Because local npm publishing cannot create trusted-publisher provenance, explicitly override the package default only for this bootstrap command with `--provenance=false`. Immediately configure the trusted publisher, restrict it to stage-only, disallow token publishing, and use staged publishing thereafter. Never store the owner's npm credentials in GitHub Actions.

Configure the `npm-production` GitHub environment with required reviewers and restrict deployment to release tags before either mode is used.

Do not publish from the repository root or a locally modified tarball. Details and verification commands are in `SUPPLY_CHAIN_SECURITY.md`.

An independent security review, evidence from the one-time bootstrap publish, and the first protected staged-publish run remain open commercial-readiness gates. Do not describe the project as certified until those controls have evidence.

## Rollback

Application rollback does not reverse database migrations. Before upgrading, create and verify a database backup. If rollback is required:

1. stop writers;
2. restore the pre-upgrade backup into a new database;
3. point the prior supported CSM version at that restored database;
4. run readiness checks before resuming traffic;
5. deprecate a bad npm release rather than silently replacing its contents.

Never delete migration-ledger rows or manually reverse production DDL in place.

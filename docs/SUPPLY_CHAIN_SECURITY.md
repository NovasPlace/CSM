# Supply-Chain Security

CSM's release controls are designed to fail closed when the production dependency inventory, license set, source history, package boundary, or release identity changes unexpectedly.

## Executable controls

| Risk | Control | Evidence |
|---|---|---|
| Known vulnerable runtime dependency | `npm run security:audit` rejects high or critical production advisories | npm audit exit status |
| Unreviewed or missing runtime license | `npm run security:licenses` checks every non-development lockfile entry against the reviewed expression set | deterministic license-policy output |
| Unknown shipped components | `npm run security:sbom` requires a clean installed tree and writes a validated CycloneDX document | `.release/sbom.cdx.json` |
| Secret committed now or historically | `scripts/verify-secrets.sh` downloads Gitleaks 8.30.1, verifies its pinned SHA-256 digest, and scans the full Git history with redacted output | CI secret-scan result |
| Mutable CI dependency | all external GitHub Actions are pinned to full commit SHAs and checked by a test | `test/supply-chain-release.test.ts` |
| Risky dependency change in a pull request | GitHub dependency review rejects newly introduced high or critical advisories | `Supply Chain Security / Dependency Review` |
| Drift in dependencies and CI actions | Dependabot proposes bounded weekly updates for npm and GitHub Actions | reviewed dependency pull requests |
| Artifact/source mismatch | the release candidate receives GitHub build-provenance and SBOM attestations | repository attestation records |
| Stolen or long-lived publish token | npm trusted publishing uses a short-lived OIDC identity | npm package provenance |
| Accidental public release | manual identity confirmation, a protected GitHub environment, candidate-only bootstrap, and npm staged publishing with maintainer 2FA approval for later versions | workflow and npm staged-package history |

## Local verification

Start from a clean dependency installation. SBOM generation intentionally rejects extraneous or invalid installed packages.

```powershell
npm ci
npm run verify:supply-chain
```

On CI, `scripts/verify-secrets.sh` performs the full-history secret scan. It is Linux-specific because the workflow downloads and verifies one exact Gitleaks archive; Windows maintainers can run the same Gitleaks version directly with `gitleaks git --redact --no-banner .`.

The 22 entries in `.gitleaksignore` are exact historical fingerprints for synthetic credentials used by the redactor benchmark and tests. They are not path-wide exclusions. Any changed or new finding fails until it is individually investigated. A real credential must be revoked and remediated; it must never be silenced with a new fingerprint.

## License policy

The production lockfile currently uses these reviewed SPDX expressions:

- `MIT`
- `ISC`
- `Apache-2.0`
- `BSD-3-Clause`
- `(MIT OR WTFPL)`
- `(AFL-2.1 OR BSD-3-Clause)`
- `(BSD-2-Clause OR MIT OR Apache-2.0)`

This list is an approval boundary, not a statement that every future package under the same license is automatically acceptable. Dependency updates still require source, maintainer, install-script, and transitive-risk review. A new license expression must fail first and be approved deliberately.

## Protected npm staging

Before `.github/workflows/release.yml` can build a candidate:

1. Create the `npm-production` GitHub environment with required reviewers and release-tag restrictions.
2. Protect `master` with required CI and supply-chain checks.
3. Create and review the exact `v<package-version>` tag.
4. Dispatch `Stage npm Release` from that tag, enter the same tag, and type the exact package `name@version` confirmation.
5. Inspect the uploaded tarball, SHA-256 manifest, SBOM, and GitHub attestations.

For a brand-new npm package, choose `candidate-only`. npm staged publishing requires the package to exist already. Download and verify the exact candidate, then perform the one-time bootstrap publish interactively with the owner account and 2FA:

```powershell
npm publish .\opencode-cross-session-memory-1.0.0.tgz --access public --provenance=false
```

Immediately after bootstrap, configure npm trusted publishing for repository `NovasPlace/CSM`, workflow `release.yml`, environment `npm-production`, with stage-only permission. Set package publishing access to require 2FA and disallow tokens.

For later versions, choose `stage`. The workflow uses OIDC to submit the attested tarball, and a maintainer reviews and approves it with 2FA. Verify the resulting npm provenance before announcing the release.

The workflow installs npm 11.15.0 because staged publishing requires it. It never accepts `NODE_AUTH_TOKEN` and never publishes from the repository root.

## Remaining assurance work

These controls do not establish certification. Independent source and architecture review, repository-setting evidence, first-release attestation verification, ongoing advisory response, and incident-response exercises remain required before stronger commercial assurance claims.

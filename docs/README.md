# Documentation

The documentation tree contains two different kinds of material:

1. **Product documentation** — stable explanations of how to install, operate, and understand CSM.
2. **Engineering evidence** — phase contracts, validation reports, migration notes, and generated repository artifacts.

Start with the product documentation. Use phase documents when you need design history or verification evidence.

## Start here

| Document | Purpose |
|---|---|
| [Main README](../README.md) | Product overview, quick start, database modes, and project status |
| [Feature Map](FEATURES.md) | Complete subsystem and runtime tool inventory |
| [Product Architecture](PRODUCT_ARCHITECTURE.md) | Stable runtime layers, write paths, read paths, and provider boundaries |
| [Contributing](https://github.com/NovasPlace/CSM/blob/master/CONTRIBUTING.md) | Development workflow, gates, migration rules, and PR expectations |
| [Security](../SECURITY.md) | Vulnerability reporting and memory-system security considerations |
| [Data Privacy and Lifecycle](DATA_PRIVACY_AND_LIFECYCLE.md) | Stored data, project isolation, retention, deletion, export, and encryption responsibilities |
| [CSM Doctor and Troubleshooting](TROUBLESHOOTING.md) | Safe installation diagnostics, common fixes, and support escalation bundle |
| [Codex Installation](CODEX_INSTALLATION.md) | Direct MCP and marketplace installation paths, support limits, and live verification |
| [Configuration Reliability](CONFIGURATION_RELIABILITY.md) | Strict configuration parsing, precedence, and failure behavior |
| [Schema Support Matrix](SCHEMA_SUPPORT_MATRIX.md) | Supported schema window and upgrade compatibility |
| [Startup and Rollback](STARTUP_ROLLBACK.md) | Atomic startup ownership and recovery behavior |
| [Release Process](RELEASE_PROCESS.md) | Artifact boundary, release gate, publishing, and rollback contract |
| [Supply-Chain Security](SUPPLY_CHAIN_SECURITY.md) | Dependency, license, SBOM, secret-scan, attestation, and publishing controls |

## Engineering evidence

The npm artifact intentionally ships the stable customer and operator documents above, not the full
engineering archive. Phase contracts, benchmark outputs, migration notes, and closure evidence remain
available in the [source documentation tree](https://github.com/NovasPlace/CSM/tree/master/docs).
This keeps the customer package bounded while preserving public implementation history.

## Generated operational documents

The following files are generated or maintained by the auto-documentation system:

- `ARCHITECTURE.md`
- `SYSTEM_MAP.md`
- `DECISIONS.md`
- `RUNBOOK.md`
- `CHANGELOG_LIVE.md`
- `DEBUG_NOTES.md`
- `AGENT_MEMORY.md`

These files are useful for live repository operations, but they are not the canonical product overview. They may contain workspace-specific paths, snapshots, or recently captured source excerpts.

Use [PRODUCT_ARCHITECTURE.md](PRODUCT_ARCHITECTURE.md) for the stable public architecture and the generated files for current operational evidence.

## Documentation ownership

| Information | Canonical location |
|---|---|
| Product positioning and setup | `README.md` |
| Feature inventory | `docs/FEATURES.md` |
| Stable architecture | `docs/PRODUCT_ARCHITECTURE.md` |
| Development workflow | `CONTRIBUTING.md` |
| Security guidance | `SECURITY.md` |
| Current project state | `AGENTBOOK_STATE.md` |
| Historical implementation evidence | `docs/PHASE*.md` |
| Generated repository graph and operating notes | Generated operational documents |

When behavior changes, update the canonical product document and the relevant contract or evidence document in the same change.

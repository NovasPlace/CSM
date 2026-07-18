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
| [Contributing](../CONTRIBUTING.md) | Development workflow, gates, migration rules, and PR expectations |
| [Security](../SECURITY.md) | Vulnerability reporting and memory-system security considerations |
| [Data Privacy and Lifecycle](DATA_PRIVACY_AND_LIFECYCLE.md) | Stored data, project isolation, retention, deletion, export, and encryption responsibilities |
| [CSM Doctor and Troubleshooting](TROUBLESHOOTING.md) | Safe installation diagnostics, common fixes, and support escalation bundle |
| [Release Process](RELEASE_PROCESS.md) | Artifact boundary, release gate, publishing, and rollback contract |
| [Supply-Chain Security](SUPPLY_CHAIN_SECURITY.md) | Dependency, license, SBOM, secret-scan, attestation, and publishing controls |

## Continuity runtime

| Document | Focus |
|---|---|
| [Re-entry Protocol](PHASE7_REENTRY_PROTOCOL.md) | Layered fresh-session continuity |
| [Re-entry UX](PHASE8A_REENTRY_UX.md) | Preview and operator-facing re-entry behavior |
| [Re-entry Enablement](PHASE8B_REENTRY_ENABLEMENT.md) | Runtime enablement and safety gates |
| [Continuity Resilience Report](PHASE6E_CONTINUITY_RESILIENCE_REPORT.md) | Continuity health model |
| [Continuity UX Export](PHASE6F_CONTINUITY_UX_EXPORT.md) | Exported continuity reporting |
| [Recall Quality Contract](PHASE6A_RECALL_QUALITY_CONTRACT.md) | Retrieval-quality definitions |
| [Recall Quality Audit Plan](PHASE6B_RECALL_QUALITY_AUDIT_PLAN.md) | Audit design |
| [Recall Telemetry Hooks](PHASE6C_TELEMETRY_HOOKS.md) | Recall-path observation |
| [Recall Quality Scoring](PHASE6D_RECALL_QUALITY_SCORING.md) | Scoring implementation |

## Living State and governance

| Document | Focus |
|---|---|
| [Belief Promotion Pipeline](PHASE4G_BELIEF_PROMOTION_PIPELINE.md) | Candidate scanning and controlled promotion |
| [Belief Knowledge Contract](PHASE4EB_BELIEF_KNOWLEDGE_CONTRACT.md) | Evidence-backed belief storage |
| [Living State Preview](PHASE4FA_LIVING_STATE_PREVIEW.md) | Advisory preview behavior |
| [Experience Packet Contract](PHASE4B5_PACKET_CONTRACT.md) | Structured observations |
| [Self-Optimizing Loop](PHASE5_SELF_OPTIMIZING_LOOP.md) | Feedback and adaptation model |

## Storage and providers

| Document | Focus |
|---|---|
| [SQLite Design](PHASE3A_SQLITE_DESIGN.md) | Provider architecture |
| [SQLite MVP](PHASE3G_SQLITE_MVP.md) | Implemented local-core contract |
| [Archive Design](PHASE2C3_ARCHIVE_DESIGN.md) | Archive and retention model |

## Context and compaction evidence

| Document | Focus |
|---|---|
| [Context Governor Results](PHASE32_CONTEXT_GOVERNOR_RESULTS.md) | Benchmark findings |
| [Context Governor Raw Outputs](PHASE32_CONTEXT_GOVERNOR_RAW_OUTPUTS.md) | Preserved benchmark evidence |
| [Trace Vault Results](PHASE33_TRACE_VAULT_RESULTS.md) | Failure and trace evidence |

## Project history

| Document | Purpose |
|---|---|
| [Phase History](PHASE_HISTORY.md) | Condensed implementation chronology |
| Individual `PHASE*.md` files | Original contracts, plans, and closure evidence |

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

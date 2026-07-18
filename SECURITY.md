# Security Policy

Cross-Session Memory stores and reconstructs agent context. That makes confidentiality, provenance, database integrity, and bounded disclosure part of the security model.

## Supported code

CSM is currently source-first and actively developed.

Security fixes target the current `master` branch. Historical commits, abandoned branches, local forks, and modified deployments may not receive fixes.

## Reporting a vulnerability

Do not open a public issue for a vulnerability.

Use GitHub private vulnerability reporting for this repository when available. Include:

- affected commit or version
- database provider
- operating system
- deployment model
- reproduction steps
- expected and observed behavior
- security impact
- proof of concept with secrets and private data removed
- suggested mitigation, when known

For reports that cannot use GitHub private vulnerability reporting, contact the repository owner privately through an established channel rather than publishing exploit details.

## Sensitive data

CSM may retain:

- source-code excerpts
- prompts and responses
- tool inputs and outputs
- file paths
- commands
- error messages
- project decisions
- user preferences
- inferred beliefs or capability observations
- database connection metadata

Treat the memory database, generated operational documents, logs, exports, and backups as sensitive project data.

## Deployment guidance

- Use a dedicated database and least-privilege database role.
- Keep database credentials outside the repository.
- Restrict filesystem permissions for SQLite files, generated state, logs, and backups.
- Encrypt storage and backups when the host environment supports it.
- Do not expose PostgreSQL directly to untrusted networks.
- Review retention, archive, and deletion behavior before storing regulated or customer data.
- Redact secrets before attaching logs to issues or pull requests.
- Keep stdout reserved for command output and stdio protocols; CSM runtime logs are emitted on stderr.
- CSM applies credential-pattern redaction to runtime logs, but operators must still review, restrict,
  rotate, and expire logs as sensitive project data.
- Review `AGENTBOOK_STATE.md` and generated auto-docs before publishing a repository.
- Keep local model, embedding, and API endpoints within the intended trust boundary.

The current product boundary for capture, project isolation, preview-first retention, deletion, export, encryption, and operator responsibilities is documented in [Data Privacy and Lifecycle](docs/DATA_PRIVACY_AND_LIFECYCLE.md).

## Memory-specific threat model

### Prompt and memory poisoning

Stored content can influence future agent behavior. Treat imported memories, transcripts, lessons, beliefs, rules, and summaries as untrusted until provenance and scope are understood.

Relevant controls include:

- provenance and source attribution
- explicit AgentBook rules
- evidence-strength distinctions
- promotion gates
- preview surfaces
- provider and source-only guards
- governance reports

These controls reduce risk but do not make arbitrary stored text safe.

### Sensitive-context disclosure

Recall, re-entry, generated summaries, and operational documents can surface information from prior sessions.

Use project isolation, database access controls, scoped retrieval, and human review when multiple users, repositories, or trust domains share infrastructure.

### Database integrity

Migration errors, partial writes, unsafe concurrency, and incorrect provider assumptions can damage continuity or produce false state.

Database-sensitive changes should include:

- fresh initialization tests
- upgrade tests
- idempotency checks
- transaction and locking review
- migration-ledger verification
- backup/restore evidence

### Derived-state overreach

Self-model scores, belief candidates, summaries, and current-state projections are derived records. They should not be treated as unquestionable source facts.

The system separates observations, candidates, promoted knowledge, summaries, and projections so callers can preserve that distinction.

### Tool-surface mismatch

A visible tool that is unsupported by the selected provider creates a false security and reliability boundary.

CSM removes known PostgreSQL-only tools from SQLite registration. New provider-specific features must preserve that behavior.

## Operational documents

Auto-generated files may contain absolute paths, source excerpts, errors, decisions, commands, or recent activity.

Before publishing or sharing:

- inspect generated files
- remove private paths and secrets
- confirm the content belongs to the intended project
- avoid committing temporary logs and database artifacts
- verify `.gitignore` coverage

## Dependency and supply-chain changes

Changes to dependencies, install scripts, CI actions, plugin loading, or package exports should receive explicit review.

Prefer pinned or bounded versions, inspect transitive behavior, and avoid introducing install-time network or shell execution without a documented need.

The executable supply-chain baseline is documented in `docs/SUPPLY_CHAIN_SECURITY.md`. It includes a production vulnerability audit, an explicit production-license policy, a validated CycloneDX SBOM, exact-fingerprint secret scanning, immutable GitHub Action references, dependency review, and an approval-gated npm staging workflow. These controls reduce release risk but are not a substitute for independent security review or repository-level GitHub and npm protection settings.

## Out of scope

The following are generally not vulnerabilities by themselves:

- behavior from unsupported historical commits
- issues requiring a compromised operating-system account with unrestricted repository and database access
- model-quality disagreements without a security impact
- intentionally disabled PostgreSQL-only features in SQLite mode
- secrets that were already committed or supplied to the system outside CSM

A report may still be reviewed when an out-of-scope condition reveals a broader design flaw.

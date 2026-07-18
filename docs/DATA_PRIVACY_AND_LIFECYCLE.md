# Data Privacy and Lifecycle

CSM stores durable agent context, so its database, exports, operational documents, logs, and backups must be treated as sensitive project data. This document defines the current product boundary and the responsibilities that remain with the operator.

## What CSM can store

Depending on configuration and agent activity, CSM can persist prompts and responses, source excerpts, tool inputs and outputs, commands, errors, file paths, project decisions, preferences, lessons, checkpoints, summaries, embeddings, inferred beliefs, and capability observations.

`CSM_AUTO_STORE_CONVERSATIONS` and `CSM_FULL_TRANSCRIPTS` default to `true`. Review those settings before using CSM with regulated, confidential, or customer-controlled content.

The redactor is enabled by default and runs before memory content is embedded or stored. It detects common secrets, credentials in URLs, email addresses, phone numbers, IP addresses, and absolute paths. Pattern redaction reduces accidental retention; it is not a data-loss-prevention guarantee and cannot identify every sensitive value.

## Project isolation

The OpenCode memory, transcript, graph, onboarding, AgentBook event/state, re-entry, work-ledger, recall-quality, maintenance, governance, and wiki-export tools are bound to the directory that registered the plugin. Their schemas do not allow an agent to select another project. Manual memories, lessons, automatic transcript captures, extracted candidates, and lifecycle observations are stamped with that bound project. A memory write is rejected if its session already belongs to a different project.

The Codex MCP memory surface requires an explicit project identifier for save, search, list, context, workflow, deletion, and cleanup operations. Customer-facing MCP search and list calls force project mode; callers cannot request a global search through those tools.

Project search retains one compatibility rule: when a project query returns no rows, it may retry against legacy memories whose `project_id` is null. It does not fall back to another named project. Legacy rows are migration data, not a tenant-security mechanism; deployments with separate trust domains should migrate or remove them.

Graph creation, graph reads, recall cascades, linked wiki notes, and deletion re-check project ownership at the database boundary. This protects current reads from historical cross-project links as well as preventing new automatic cross-project graph links.

### Trust boundary

Project identifiers provide local data partitioning, not authentication or hostile multi-tenant authorization. A process with direct database credentials, filesystem access to the SQLite file, or access to the programmatic `MemoryManager` and unrestricted bridge APIs is an operator.

Some installation-level surfaces are intentionally broader:

- project inventory and aggregate runtime diagnostics can describe all scopes;
- self-model and belief state describe the agent installation rather than one repository;
- AgentBook operating rules are installation-wide in the current schema, including rules labeled `project` or `session`; do not use that label as a tenant-isolation control;
- direct database administration, backups, and programmatic global queries are operator capabilities.

Use separate databases and credentials for different users or mutually untrusted tenants. CSM does not currently ship an identity provider, row-level-security policy, or hosted tenant authorization layer.

## Retention cleanup

Retention cleanup is explicit and preview-first. It never runs automatically on startup.

- OpenCode `memory_cleanup` is bound to the active project; Codex MCP `memory_cleanup` requires `projectRoot`.
- Omitting `apply` or setting `apply=false` returns counts without changing data.
- `apply=true` hard-deletes only eligible memories in that project.
- `maxDelete` limits one applied run to 1-10,000 memories and defaults to 1,000.
- A disabled TTL policy produces no eligible memories.
- Applied cleanup emits a `memory.retention_cleanup` event containing project and count metadata, not deleted content.

Eligibility uses the longest applicable retention period: the memory-type period, matching importance-band period, or grace period. This prevents a shorter rule from unexpectedly overriding a longer preservation rule. Default importance bands retain low-importance memories for 30 days, medium for 90 days, and high for 180 days; type rules can extend those periods, including 365 days for lessons.

Deleting a memory removes database dependents covered by foreign-key cascades. It does not remove content already copied into generated documents, wiki exports, application logs, database snapshots, filesystem backups, or third-party backup systems. Those stores need their own retention and deletion procedures.

## Direct deletion

Memory deletion requires both a memory ID and the active project. A request using the correct numeric ID but the wrong project returns `deleted: false` and leaves the row intact. This rule is enforced in SQL on PostgreSQL and SQLite.

Deletion is a hard database mutation and is not undoable through the memory tool. Use a verified backup when recovery requirements apply.

## Export

The OpenCode wiki-export tool is bound to the active project. One-hop linked notes are re-filtered by project, and link metadata is rendered only when both endpoints are in the export set. SQLite export degrades cleanly when PostgreSQL-only distilled summaries are unavailable.

Wiki output is a separate copy. Database deletion and retention cleanup do not update or erase an existing export. Use a separate output directory per project, protect its permissions, and manage its manifest, pruning, backup, and deletion lifecycle independently.

The wiki exporter is a memory-content export, not a complete privacy-request or legal-discovery export. It does not promise to include every operational, telemetry, belief, checkpoint, log, generated-document, or backup record.

## Encryption and transport

CSM does not provide application-level field encryption.

- For PostgreSQL, use a least-privilege role, restrict network exposure, and set `CSM_DB_TLS_MODE=require` or `verify-full` when the connection crosses an untrusted network. `verify-full` is the preferred remote-production mode.
- For SQLite, restrict access to the database, WAL, and SHM files and use operating-system or volume encryption where required.
- Encrypt backups and export destinations separately and protect their keys outside the repository.
- Embedding providers receive the redacted content supplied for embedding. Keep local endpoints inside the intended trust boundary and review external-provider data terms before use.

## Operator checklist

Before production use:

1. Decide whether conversation and full-transcript capture are appropriate.
2. Test redaction against representative sensitive data.
3. Isolate trust domains with separate databases and credentials.
4. Configure PostgreSQL TLS or encrypted local storage.
5. Run cleanup in preview mode and record approval before `apply=true`.
6. Define separate retention for logs, generated documents, exports, and backups.
7. Test backup restoration and deletion procedures.
8. Restrict who can invoke operator-wide diagnostics or use direct database access.

CSM is not certified for a particular regulatory regime. Operators remain responsible for data classification, lawful basis, consent, access requests, deletion SLAs, retention schedules, residency, incident response, and vendor review.

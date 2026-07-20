# CSM Doctor and Troubleshooting

`csm-doctor` is the first support step for a CSM installation. It checks the packaged runtime,
supported Node.js version, strict configuration, production-hardening baseline, database
connectivity, and the complete migration ledger. Its database checks are non-destructive: SQLite
is opened read-only and PostgreSQL receives queries only.

## Run the doctor

From an installed release:

```bash
npx --yes --package=opencode-cross-session-memory@1.0.0 csm-doctor
```

From a source checkout after `npm run build`:

```bash
npm run doctor
```

The default run does not contact the configured embedding provider. Add `--online` to send one
bounded probe and verify provider availability, model selection, and vector dimensions:

```bash
npx --yes --package=opencode-cross-session-memory@1.0.0 csm-doctor --online
```

Use `--json` for a machine-readable support report. The report includes no database credentials,
API keys, or memory content. Review it before sharing because ordinary operational metadata such as
provider names, model names, versions, and error text remains visible.

```bash
npx --yes --package=opencode-cross-session-memory@1.0.0 csm-doctor --json
```

`PASS` and `WARN` exit with status 0. `FAIL` exits nonzero. A warning identifies a production
hardening item but does not mean the local runtime is broken. A skipped embedding check is expected
unless `--online` was requested.

## Common findings

### The SQLite database does not exist

Run `csm-init` from the same project directory and with the same `.env` used by OpenCode:

```bash
npx --yes --package=opencode-cross-session-memory@1.0.0 csm-init
```

Do not point `CSM_SQLITE_PATH` at `:memory:` for persistent use.

### PostgreSQL cannot be reached

Confirm that the service is running and that `CSM_DATABASE_URL` names the intended database. Check
network access, database credentials, and TLS policy. For a remote production database, prefer
`CSM_DB_TLS_MODE=verify-full` and a trusted certificate chain.

### The schema is missing, outdated, or incompatible

Back up the database first. Run the matching release's `csm-init`, then rerun `csm-doctor`. CSM
validates every recorded migration ID, provider, and checksum and also rejects missing migrations.
Do not edit the migration ledger by hand.

### Ollama embeddings fail

Confirm Ollama is running at `OLLAMA_HOST`, install the configured model (the default is
`nomic-embed-text`), and ensure `CSM_EMBEDDING_DIMENSIONS` matches its output. Then rerun with
`--online`.

### OpenAI embeddings fail

Confirm `OPENAI_API_KEY` is present in the runtime environment and authorized for embeddings. The
default model is `text-embedding-3-small`; the default dimension is 1536. Doctor output redacts the
key.

### Production hardening warning

For PostgreSQL, set an explicit `CSM_DATABASE_URL`. Enable TLS when the connection crosses an
untrusted network. Keep TTL retention enabled or document and test an external deletion policy.
See [Data Privacy and Lifecycle](DATA_PRIVACY_AND_LIFECYCLE.md) for the complete operator boundary.

## Escalation bundle

When asking for support, include:

1. CSM version and host version.
2. `csm-doctor --json` output after reviewing it.
3. Database provider and whether the failure began after an install, configuration change, or
   upgrade.
4. The smallest reproducible action and its timestamp.

Never include `.env`, database dumps, raw memories, transcripts, API keys, or unredacted connection
strings in a support ticket.

Redaction protects new writes at supported persistence boundaries; it does not rewrite old rows,
generated files, exports, logs, or backups. If an older installation may have captured a credential,
rotate it first and inspect each copy before sharing diagnostics or deleting data.

## Log collection

CSM emits runtime logs on stderr so stdout remains safe for JSON reports and MCP JSON-RPC traffic.
Hook and tool logs include request-local project/session/tool correlation when the host supplies it.
Credential patterns are redacted before emission, but logs can still contain project paths,
operational metadata, and caller-provided error text. Apply access controls and retention limits,
and review the exact excerpt before sharing it.

## Codex cannot start CSM

For project MCP setup, confirm `.codex/config.toml` invokes the pinned `csm-mcp` command with the
project as its working directory. Run `codex mcp list`, then run `csm-doctor --online` from that same
directory. Restart Codex after changing MCP configuration.

The npm-backed Codex marketplace plugin is PostgreSQL-only and refuses the insecure default database
URL. Make `CSM_DATABASE_URL` available to the Codex host before it launches the plugin. If SQLite is
required, use the direct project MCP path in [Codex Installation](CODEX_INSTALLATION.md); marketplace
installs do not run the native SQLite binding's lifecycle step.

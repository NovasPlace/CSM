# Codex Installation

CSM has two self-hosted Codex connection paths. The direct project MCP setup is the recommended
customer path because it keeps configuration with the project and supports both PostgreSQL and
SQLite. The installable Codex plugin is a PostgreSQL-only convenience for teams that distribute
plugins through a Codex marketplace.

CSM is not a hosted service. In both paths, the database and embedding provider remain under the
operator's control.

| Path | Storage | Best for |
|---|---|---|
| Project MCP with `csm-mcp` | PostgreSQL or SQLite | Individual projects, local development, and the clearest support boundary |
| Codex marketplace plugin | PostgreSQL only | Teams already distributing npm-backed plugins through a managed marketplace |

## Recommended: project MCP

### 1. Configure and initialize storage

Create a project `.env` using the settings in the main [quick start](../README.md#quick-start). Then
initialize and diagnose the pinned package:

```bash
npx --yes --package=opencode-cross-session-memory@1.0.0 csm-init
npx --yes --package=opencode-cross-session-memory@1.0.0 csm-doctor --online
```

Do not continue until Doctor reports that the runtime, database, migration ledger, and embedding
provider are ready.

### 2. Add the MCP server to the project

Create or extend `.codex/config.toml` in the project:

```toml
[mcp_servers.cross_session_memory]
command = "npx"
args = ["--yes", "--package=opencode-cross-session-memory@1.0.0", "csm-mcp"]
cwd = "."
startup_timeout_sec = 30
tool_timeout_sec = 120
required = true
default_tools_approval_mode = "writes"
```

`csm-mcp` reads `.env` from its working directory. Keep `cwd` pointed at the project that owns the
configuration. Use an absolute path if the host does not resolve `.` to the project root. Never put
database credentials or API keys directly in committed `config.toml`.

Codex documents project MCP configuration and stdio settings in its
[MCP setup guide](https://learn.chatgpt.com/docs/config-file/basic#mcp-servers).

### 3. Verify the live surface

Restart Codex after changing MCP configuration, then verify the server is visible:

```bash
codex mcp list
```

In a fresh task, ask Codex to call `csm_runtime_status`, then build a context brief for the current
project. A healthy result must identify the intended database provider and project; fix any mismatch
before saving customer data.

## Codex marketplace plugin

Codex can install npm-backed plugins from a marketplace catalog. A repository catalog entry for the
pinned CSM package has this shape:

```json
{
  "name": "csm-plugins",
  "interface": { "displayName": "Cross-Session Memory" },
  "plugins": [
    {
      "name": "cross-session-memory-bridge",
      "source": {
        "source": "npm",
        "package": "opencode-cross-session-memory",
        "version": "1.0.0",
        "registry": "https://registry.npmjs.org"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

Place the catalog at `.agents/plugins/marketplace.json`, refresh the Plugins directory, and install
the pinned version. See the official [plugin-building and marketplace guide](https://learn.chatgpt.com/docs/build-plugins)
for catalog and installation behavior.

The bundled plugin enforces PostgreSQL plus an explicit `CSM_DATABASE_URL`. Make the database and
embedding environment variables available to the Codex host before it launches the plugin. Run
`csm-doctor --online` from the target project before installation and after each upgrade.

### Why the marketplace plugin is PostgreSQL-only

Codex downloads npm marketplace plugins without running lifecycle scripts. CSM's SQLite adapter uses
`better-sqlite3`, whose native binding is installed by a lifecycle script. Silently advertising SQLite
on this path would produce an installation that can be discovered but cannot open its database.

Use the direct `csm-mcp` setup when SQLite is required. Normal `npx` package installation runs the
native dependency setup; Doctor then verifies the resulting database path before use.

## Upgrade and rollback

- Pin the package version in either `config.toml` or the marketplace catalog.
- Back up PostgreSQL or the SQLite file before changing the pin.
- Run `csm-init` and `csm-doctor --online` with the new version before normal writes resume.
- Roll back by restoring the pre-upgrade database backup and the previous package pin together.

See [Schema Support Matrix](SCHEMA_SUPPORT_MATRIX.md), [Release Process](RELEASE_PROCESS.md), and
[Troubleshooting](TROUBLESHOOTING.md) for the supported migration and escalation contracts.

# Codex Installation

CSM has three self-hosted Codex connection paths. The direct project MCP setup is the recommended
customer path because it keeps configuration with the project. The repository also includes a
native Codex plugin for local development, while the npm-backed marketplace package remains a
PostgreSQL-only distribution path.

CSM is not a hosted service. In both paths, the database and embedding provider remain under the
operator's control.

| Path | Storage | Best for |
|---|---|---|
| Project MCP with `csm-mcp` | PostgreSQL or SQLite | Individual projects, local development, and the clearest support boundary |
| Repo-local native plugin | PostgreSQL or SQLite | Developing CSM from a trusted checkout |
| npm marketplace plugin | PostgreSQL only | Teams distributing pinned releases through a managed marketplace |

Both native plugin forms bundle the `csm-continuity` skill, all 51 tools from CSM's canonical
registry, the compatibility bridge tools, and lifecycle hooks for session start, user prompts,
tool execution, permissions, compaction, subagents, and stop events. The persistent native runtime
also runs the normal self-model, belief-consolidation, living-state, recall, subconscious, git,
statistics, work-ledger, and AgentBook services. Current files and user instructions remain more
authoritative than recalled memory.

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

## Repo-local native plugin

The repository catalog at `.agents/plugins/marketplace.json` points to the self-contained plugin in
`plugins/cross-session-memory-bridge`. Its launcher uses the locally staged runtime only; it never
downloads or executes a fallback package at startup.

Build CSM, add this repository as a non-default local marketplace, and install the plugin:

```bash
npm run plugin:build
codex plugin marketplace add .
codex plugin add cross-session-memory-bridge@cross-session-memory-local
```

Expose `CSM_DATABASE_PROVIDER` plus the matching database variables to the Codex host. PostgreSQL
requires `CSM_DATABASE_URL`; SQLite uses `CSM_SQLITE_PATH`. Configure `CSM_EMBEDDING_PROVIDER` and
either `OLLAMA_HOST` or `OPENAI_API_KEY` as appropriate. The local build records the checkout as a
configuration directory without copying `.env` or credentials into the plugin cache.

After installation, open `/hooks`, review the exact plugin hook definition, and trust it. Hook trust
is hash-bound, so repeat that review after a plugin update changes `hooks/hooks.json`. Start a new
Codex task after installing so the MCP tools, lifecycle hooks, and `csm-continuity` skill are loaded
together.

Verify the complete native surface in the new task:

1. `csm_runtime_status` reports the runtime and database connected.
2. The MCP server lists the 51 canonical tools, including living state, beliefs, self-model,
   AgentBook, checkpoints, context cache, goals, work ledger, onboarding, wiki export, and re-entry.
3. The first turn receives CSM onboarding and `<agent_reentry_context>` from `SessionStart` or
   `UserPromptSubmit`; it must not claim that runtime tools are unavailable.

For a shareable Windows archive with an integrity manifest and one-command installer, use the
[portable plugin release process](CODEX_PLUGIN_PORTABLE_RELEASE.md).

## npm marketplace plugin

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

The npm-backed plugin enforces PostgreSQL plus an explicit `CSM_DATABASE_URL`. Make the database and
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

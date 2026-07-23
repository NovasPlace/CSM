# Claude Code Installation

The Cross-Session Memory (CSM) runtime installs into Claude Code as a **native plugin**:
lifecycle hooks, the full MCP tool surface, slash commands, subagents, and skills — all wired
together. It runs alongside the Codex plugin without interference (each host gets its own
lifecycle transport, keyed by host + workspace root).

## What ships

The plugin lives at `plugins/cross-session-memory/`:

- `.claude-plugin/plugin.json` — the plugin manifest.
- `.mcp.json` — the MCP server (`cross-session-memory`), launched via `scripts/launch-mcp.mjs` →
  `dist/claude-mcp-server.js`. Serves the full CSM tool catalog (82 entries).
- `hooks/hooks.json` — all 10 lifecycle events (`SessionStart`, `UserPromptSubmit`, `PreToolUse`,
  `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`,
  `SubagentStop`, `Stop`) → `scripts/run-hook.mjs` → `dist/cli/claude-hook-client.js`.
- `commands/` — 12 slash commands (`/csm-recall`, `/csm-brief`, `/csm-checkpoint`, `/csm-handoff`,
  `/csm-goals`, `/csm-beliefs`, `/csm-selfmodel`, `/csm-agentbook`, `/csm-governance`,
  `/csm-compaction`, `/csm-reentry`, `/csm-workledger`).
- `agents/` — 3 subagents (`csm-archivist`, `csm-continuity-scout`, `csm-handoff-writer`).
- `skills/` — `csm-continuity`, `csm-governance`, `csm-handoff`.
- `surface-catalog.json` — the single source of truth for the command/agent/skill surface.

## 1. Configure storage and embeddings

CSM needs a database and an embedding provider. Set these via environment (or a `.env` under
`%LOCALAPPDATA%\CrossSessionMemory\config`), matching `.mcp.json`'s `env_vars` allowlist:

```bash
# Storage: sqlite (local, default) or postgres
CSM_DATABASE_PROVIDER=sqlite
CSM_SQLITE_PATH=C:/path/to/csm.sqlite
# CSM_DATABASE_URL=postgresql://user:password@host:5432/csmdb

# Embeddings: ollama or openai
CSM_EMBEDDING_PROVIDER=ollama
OLLAMA_HOST=http://127.0.0.1:11434
# OPENAI_API_KEY=
```

## 2. Build the runtime

From the repository root:

```bash
npm install
npm run plugin:build:claude
```

`plugin:build:claude` compiles `dist/` and stages the full runtime (dist + production
`node_modules`) into `plugins/cross-session-memory/runtime/package/` with a `runtime-manifest.json`
pointing at `dist/claude-mcp-server.js`. For local development the launch scripts also resolve the
repo-root `dist/`, so a plain `npm run build` is enough to iterate.

## 3. Install the plugin

Claude Code installs the plugin from the bundled local marketplace at `.agents/plugins`:

```
/plugin marketplace add <repo>/.agents/plugins
/plugin install cross-session-memory
```

Fully restart Claude Code. Open `/hooks`, review and trust the CSM lifecycle hooks, then start a
fresh task so the tools, commands, subagents, skills, and hooks load together.

## 4. Verify the live surface

- Run `/csm-brief` (or ask Claude to call `csm_runtime_status`) — it should report a connected
  database.
- `/hooks` should list the 10 CSM lifecycle events.
- The `csm-continuity` skill should trigger when you ask to search memory or build a brief.

To validate the bundle offline:

```bash
npm run plugin:surface:claude   # catalog <-> files <-> live MCP tools agree
```

## Running alongside Codex

The Codex plugin (`plugins/cross-session-memory-bridge/`) and the Claude plugin are independent
bundles. The lifecycle relay transport is a named pipe / socket keyed by **host + plugin-root
hash** (`csm-claude-<hash>` vs `csm-codex-<hash>`), so concurrent Codex and Claude sessions — and
multiple Claude workspaces — never share a transport or consume each other's hook messages.

## Upgrade and rollback

- **Upgrade:** rebuild (`npm run plugin:build:claude`), then in Claude Code
  `/plugin marketplace update` and reinstall. Restart Claude Code.
- **Rollback:** reinstall a prior built version, or `git restore` the working tree and rebuild.
  The Codex path is untouched by the Claude bundle; the two can be upgraded independently.

## Packaged release

For a portable, self-contained Windows release ZIP, see
[CLAUDE_PLUGIN_PORTABLE_RELEASE.md](CLAUDE_PLUGIN_PORTABLE_RELEASE.md).

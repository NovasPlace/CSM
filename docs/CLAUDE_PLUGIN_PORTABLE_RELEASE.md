# Portable Claude Code Plugin Release

This produces a self-contained Windows release of the native Claude Code CSM plugin: the compiled
runtime, its production `node_modules` (including the `better-sqlite3` native binary), the full
command/agent/skill surface, and a local marketplace — everything needed to install with no network
access and no repository checkout.

## Build

On a `win32-x64` machine with the target Node.js major version:

```bash
npm run plugin:release:claude:windows
```

This runs `plugin:build:claude` (compile + stage the runtime) and then
`scripts/build-claude-plugin-release.mjs`, which:

- copies the bundle (`.claude-plugin`, `.mcp.json`, `surface-catalog.json`, `hooks`, `scripts`,
  `commands`, `agents`, `skills`, and the staged `runtime/`) into `.release/`,
- emits a Claude `marketplace.json`, `release.json`, `README.md`, `csm.env.example`, and `LICENSE`,
- writes `MANIFEST.sha256` over every bundled file and `SHA256SUMS.claude.txt` over the ZIP,
- refuses to include `.env`, credentials, keys, or any developer-machine path (sanitization gate).

The artifact is named:

```
cross-session-memory-claude-plugin-<version>-windows-x64-node<major>.zip
```

## Verify (clean room)

```bash
npm run plugin:release:verify:claude:windows
```

`scripts/verify-claude-plugin-release.mjs` extracts the ZIP into a throwaway directory and boots
**only** the packaged bundle — no repository sources, no external host binary. It asserts:

- the packaged launcher starts and serves the full tool surface (82 entries),
- the runtime connects to a fresh SQLite store (`csm_runtime_status`),
- a native tool write (`csm_memory_save`) and read (`csm_memory_search`) each execute,

then tears the temporary environment down. This is the release gate: if the produced ZIP cannot
install-and-run on its own, verification fails.

## Install the release

Claude Code installs the release natively — no installer script:

```
/plugin marketplace add <extracted-folder>/.agents/plugins
/plugin install cross-session-memory
```

Restart Claude Code, trust the hooks under `/hooks`, and start a fresh task. See
[CLAUDE_INSTALLATION.md](CLAUDE_INSTALLATION.md) for configuration and verification details.

## Integrity

`MANIFEST.sha256` covers every file inside the extracted bundle; `SHA256SUMS.claude.txt` covers the
ZIP itself. The build fails if any secret-like file or developer path is detected in the staged
release.

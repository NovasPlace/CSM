# Portable Codex Plugin Release

The Windows portable release is the shareable distribution of the complete native CSM plugin. It
contains the staged runtime, all production dependencies, the canonical and compatibility tools,
lifecycle hooks, the CSM continuity skill, a local marketplace, an integrity manifest, and a
one-command installer.

It does not contain `.env`, credentials, databases, memories, developer paths, or generated
AgentBook state.

## Build

Build on Windows x64 using the Node major intended for the release. SQLite's native driver is tied
to the Node ABI, so each archive records and enforces its build-time Node major and ABI.

```powershell
npm ci
npm run plugin:release:windows
```

The command writes these ignored artifacts under `.release/`:

- `cross-session-memory-codex-plugin-<version>-windows-x64-node<major>.zip`
- `SHA256SUMS.txt`
- the expanded release directory used for inspection

The build fails if an absolute developer path or a secret-like file enters the artifact.

## Verify

Run the installer and packaged MCP runtime against an isolated `CODEX_HOME`:

```powershell
npm run plugin:release:verify:windows -- --codex-exe C:\path\to\codex.exe
```

Verification extracts the ZIP, checks its integrity manifest, installs it into temporary paths,
registers its marketplace in an isolated Codex profile, starts the installed MCP launcher, checks
all 82 MCP entries, calls `csm_runtime_status`, confirms SQLite connectivity, and removes the
temporary profile.

## Share

Upload the ZIP and `SHA256SUMS.txt` together to a GitHub release. Recipients verify the archive,
extract it, and run:

```powershell
.\install.cmd
```

The installer preserves an existing CSM configuration. When none exists, it creates a fresh local
SQLite configuration under `%LOCALAPPDATA%\CrossSessionMemory`; it never copies publisher data or
credentials. PostgreSQL and OpenAI embedding users can edit the local `.env` after installation.

After installation, fully restart Codex, review and trust the plugin hooks under `/hooks`, and use a
fresh task so Codex loads the tools, skill, and lifecycle hooks together.

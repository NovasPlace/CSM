# Cross-Session Memory native Codex plugin

Version: `{{VERSION}}`  
Platform: Windows x64  
Runtime: Node.js {{NODE_MAJOR}} (ABI {{NODE_ABI}})

This is the complete native CSM runtime: all canonical tools, compatibility aliases, lifecycle
hooks, onboarding, re-entry, living state, beliefs, self-model, AgentBook, checkpoints, context
cache, goals, work ledger, compaction, telemetry, and handoff automation.

## Install

Extract the ZIP, open PowerShell in this folder, and run:

```powershell
.\install.cmd
```

The installer verifies every bundled file, copies this immutable version under
`%LOCALAPPDATA%\CrossSessionMemory\CodexPlugin`, registers the local marketplace, and installs the
plugin. It creates a fresh local SQLite configuration only when no CSM configuration exists.

After installation, fully restart Codex, open `/hooks`, review and trust the CSM hooks, and start a
fresh task. Ask Codex to call `csm_runtime_status` to confirm the database connection.

## Data and secrets

The archive contains no `.env`, credentials, database, memories, or developer-machine paths. The
installer stores local configuration under `%LOCALAPPDATA%\CrossSessionMemory\config` and local
SQLite data under `%LOCALAPPDATA%\CrossSessionMemory\data`.

To use PostgreSQL or OpenAI embeddings, edit the installed `.env` using `csm.env.example` as the
reference. Never send your populated `.env` with the plugin.

## Integrity

`MANIFEST.sha256` covers every file inside the extracted bundle. The adjacent release
`SHA256SUMS.txt` covers the ZIP itself. The installer refuses modified or incomplete bundles.

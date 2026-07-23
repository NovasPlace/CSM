# Cross-Session Memory — native Claude Code plugin

Version: `{{VERSION}}`  
Platform: Windows x64  
Runtime: Node.js {{NODE_MAJOR}} (ABI {{NODE_ABI}})

This is the complete native CSM runtime for Claude Code: all canonical tools, lifecycle hooks,
slash commands, subagents, skills, onboarding, re-entry, living state, beliefs, self-model,
AgentBook, checkpoints, context cache, goals, work ledger, compaction, telemetry, and handoff
automation.

## Install

Claude Code installs this plugin natively from the bundled local marketplace — no installer
script is required. Extract the ZIP, then from Claude Code:

```
/plugin marketplace add <extracted-folder>/.agents/plugins
/plugin install cross-session-memory
```

Fully restart Claude Code, open `/hooks`, review and trust the CSM lifecycle hooks, and start a
fresh task so the tools, commands, subagents, skills, and hooks load together. Run `/csm-brief` or
ask Claude to call `csm_runtime_status` to confirm the database connection.

## Configuration

Set the storage and embedding provider via environment variables (see `csm.env.example`), or place
a `.env` under `%LOCALAPPDATA%\CrossSessionMemory\config`. The plugin defaults to a local SQLite
store and stores runtime stats under the plugin data directory. To use PostgreSQL or OpenAI
embeddings, edit that `.env` using `csm.env.example` as the reference. Never ship your populated
`.env` with the plugin.

## Data and secrets

The archive contains no `.env`, credentials, database, memories, or developer-machine paths.

## Integrity

`MANIFEST.sha256` covers every file inside the extracted bundle. The adjacent
`SHA256SUMS.claude.txt` covers the ZIP itself.

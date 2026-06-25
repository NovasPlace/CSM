# cross-session-memory

Cross-session memory plugin for OpenCode. Persists memories, checkpoints, and context across OpenCode sessions using PostgreSQL with pgvector.

## Features

- **Persistent Memory** — Save and recall memories across OpenCode sessions (14,000+ memories from June 2026)
- **Automatic Checkpointing** — Creates checkpoints on risky operations, session end, and context rollover
- **Context Compaction** — Automatically compacts long conversations with distillation (93% token reduction)
- **Semantic Search** — Vector-based memory search using pgvector
- **Multiple Memory Types** — conversation, workspace, repo, preference, lesson
- **Subconscious Processing** — Background distillation of tool calls into structured memories
- **Live Documentation** — Auto-maintained project docs: SYSTEM_MAP, CHANGELOG, DECISIONS, DEBUG_NOTES, AGENT_MEMORY, RUNBOOK
- **Auto-Doc Hooks** — Noise-guarded documentation updates on every file edit (dedup, grouping, ignored paths, caps)
- **Mermaid Diagrams** — Module graph, data flow, memory pipeline, auto-docs flow, compaction/rollover flow

## Architecture

```
OpenCode Session
    ↓
Hooks: onUserMessage, onToolCall
    ↓
Memory Extractor → PostgreSQL + pgvector
    ↓
Context Cache → Compaction → Rollover
    ↓
Distilled Summaries → Recall → Injected Context
    ↓
Live Docs (auto-updated) + Mermaid Diagrams
```

## Installation

```bash
# Install globally
npm install -g @your-org/cross-session-memory

# Or install locally in your project
npm install @your-org/cross-session-memory
```

Then add to your `.opencode/opencode.json`:

```json
{
  "plugins": [
    {
      "name": "cross-session-memory",
      "path": "node_modules/@your-org/cross-session-memory"
    }
  ]
}
```

## Configuration

Configure via environment variables or `.opencode/cross-session-memory.json`:

```json
{
  "database": {
    "host": "localhost",
    "port": 5432,
    "database": "opencode_memory",
    "user": "opencode_memory",
    "password": "opencode_memory"
  },
  "embedding": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "apiKey": "your-api-key"
  },
  "autoDocs": {
    "enabled": true,
    "ignoredPaths": ["docs/", "dist/", "node_modules/", "coverage/", ".git/"],
    "maxChangelogEntriesPerSession": 50,
    "maxEntryLength": 200,
    "deduplicateEdits": true,
    "groupMultipleEdits": true
  },
  "retention": {
    "maxMemories": 50000,
    "maxCheckpoints": 500,
    "maxContextCache": 100000
  }
}
```

### Required: PostgreSQL with pgvector

```sql
CREATE DATABASE opencode_memory;
CREATE USER opencode_memory WITH PASSWORD 'opencode_memory';
GRANT ALL PRIVILEGES ON DATABASE opencode_memory TO opencode_memory;
\c opencode_memory
CREATE EXTENSION IF NOT EXISTS vector;
```

## Usage

The plugin provides these tools to OpenCode:

- `memory_save` — Save a memory
- `memory_search` — Search memories semantically
- `memory_list` — List recent memories
- `memory_delete` — Delete a memory
- `context_fetch` — Fetch cached context
- `context_search` — Search cached context
- `checkpoint_create` — Create a checkpoint
- `checkpoint_list` — List checkpoints
- `checkpoint_restore` — Restore from checkpoint
- `goal_set` — Set session goal
- `goal_list` — List goals

## Live Documentation

The plugin auto-maintains these files in `docs/`:

| File | Purpose |
|------|---------|
| `SYSTEM_MAP.md` | Module inventory, data flow, dependencies, config schema
| `CHANGELOG_LIVE.md` | Per-turn development log (files changed, why, verification)
| `DECISIONS.md` | Architecture decisions with rationale
| `DEBUG_NOTES.md` | Failure points, error patterns, recovery procedures
| `AGENT_MEMORY.md` | Lessons learned, conventions, "don't repeat" rules
| `RUNBOOK.md` | Build/test/DB/smoke/recovery/release commands |

Diagrams in `docs/diagrams/` (Mermaid, viewable in GitHub/VS Code):

| Diagram | Purpose |
|---------|---------|
| `module-graph.mmd` | Module imports & responsibilities |
| `data-flow.mmd` | End-to-end data flow (hooks → memory → recall → docs) |
| `memory-pipeline.mmd` | Extraction → storage → distillation → recall |
| `auto-docs-flow.mmd` | tool.execute → queue → dedup/group → flush |
| `compaction-rollover-flow.mmd` | Context → compaction → rollover → recall |

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Test (all 68 tests)
npm test

# Run specific test
node --experimental-strip-types --test test/auto-docs.test.ts

# Watch mode
npm run dev
```

## Database Schema

- `sessions` — OpenCode session tracking
- `memories` — Cross-session memories with embeddings
- `checkpoints` — Session checkpoints with full context
- `context_cache` — Cached context for rollover
- `distilled_summaries` — Compressed tool call summaries
- `goals` — Session goals
- `context_rollover` — Context compaction history

## License

MIT
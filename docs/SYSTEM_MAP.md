# SYSTEM_MAP.md

## Project: Cross-Session Memory Plugin for OpenCode

**Purpose**: Persistent cross-session memory using PostgreSQL, surviving OpenCode reinstalls.

---

## Module Inventory

| File | Responsibility | Key Exports |
|------|---------------|-------------|
| `src/index.ts` | Plugin entry point, registers all tools, hooks, subagents | `plugin` (OpenCode plugin object) |
| `src/database.ts` | PostgreSQL connection pool, schema migrations, CRUD for memories | `Database`, `getDatabase()`, `closeDatabase()` |
| `src/config.ts` | Configuration schema, defaults, validation | `Config`, `DEFAULT_CONFIG`, `validateConfig()` |
| `src/types.ts` | TypeScript interfaces for memories, tools, config | `Memory`, `MemoryType`, `ToolCall`, `ContextBrief`, etc. |
| `src/memory-manager.ts` | High-level memory operations (save, search, list, delete) | `MemoryManager` class |
| `src/memory-extractor.ts` | Extracts structured memories from conversation turns | `MemoryExtractor` class, `extractMemories()` |
| `src/tools.ts` | OpenCode tool definitions (memory_save, memory_search, etc.) | `memoryTools` array |
| `src/context-recall.ts` | Builds context brief from relevant memories | `ContextRecall` class, `buildContextBrief()` |
| `src/priming-engine.ts` | Primes agent with relevant memories at session start | `PrimingEngine` class, `prime()` |
| `src/subconscious.ts` | Background memory consolidation, distillation | `Subconscious` class |
| `src/context-compactor.ts` | Compresses tool outputs for context window | `ContextCompactor` class |
| `src/tool-distiller.ts` | Distills tool activity into structured summaries | `ToolDistiller` class |
| `src/hooks/auto-docs.ts` | Auto-updates live docs on file edits, flushes on session end. Noise guard: dedup, grouping, ignored paths, caps, config toggle. | `queueDocUpdate()`, `flushDocUpdates()`, `isIgnoredPath()`, `DEFAULT_AUTO_DOCS_CONFIG` |
| `src/hooks/tool-execute.ts` | Tool execution hook — logs to memory + queues doc updates | `registerToolExecuteHook()` |
| `src/hooks/system-transform.ts` | System prompt transformation hook | `registerSystemTransformHook()` |
| `src/hooks/session-compaction.ts` | Session compaction hook | `registerSessionCompactionHook()` |

---

## Data Flow

```
User Message → OpenCode
    ↓
Plugin hooks: onUserMessage, onToolCall
    ↓
Tool Distiller → Context Compactor → Subconscious (background)
    ↓
Memory Extractor → structured memories
    ↓
Memory Manager → PostgreSQL (memories table)
    ↓
Context Recall → builds ContextBrief for agent
    ↓
Priming Engine → injects relevant memories at session start
```

### Auto-Documentation Flow (Phase 2)
```
Tool Execute (write/edit) → tool-execute.after hook
    ↓
queueDocUpdate(filePath, changeType)
    ↓
Session End (dispose) → flushDocUpdates(pluginCtx)
    ↓
Read changed source files → Update relevant docs
    ↓
Write updated docs to /docs
```

---

## Database Schema (PostgreSQL)

**Table: `memories`**
- `id` SERIAL PRIMARY KEY
- `content` TEXT NOT NULL
- `type` VARCHAR(50) NOT NULL (conversation, workspace, repo, preference, lesson)
- `importance` REAL DEFAULT 0.5
- `tags` TEXT[] DEFAULT '{}'
- `linked_memory_ids` INTEGER[] DEFAULT '{}'
- `created_at` TIMESTAMPTZ DEFAULT NOW()
- `updated_at` TIMESTAMPTZ DEFAULT NOW()
- `accessed_at` TIMESTAMPTZ
- `embedding` VECTOR(1536) — for semantic search (pgvector)

**Indexes**: GIN on tags, IVFFLAT on embedding, BTREE on type/importance/created_at

---

## Diagrams

| Diagram | File | Purpose |
|---------|------|---------|
| **Module Graph** | [`diagrams/module-graph.mmd`](diagrams/module-graph.mmd) | Module imports & responsibilities |
| **Data Flow** | [`diagrams/data-flow.mmd`](diagrams/data-flow.mmd) | End-to-end data pipeline |
| **Memory Pipeline** | [`diagrams/memory-pipeline.mmd`](diagrams/memory-pipeline.mmd) | Extraction → distillation → storage |
| **Auto-Docs Flow** | [`diagrams/auto-docs-flow.mmd`](diagrams/auto-docs-flow.mmd) | Hook → queue → flush → docs |
| **Compaction & Rollover** | [`diagrams/compaction-rollover-flow.mmd`](diagrams/compaction-rollover-flow.mmd) | Context pressure → compress → archive |

Render in GitHub, VS Code (Mermaid preview), or `npx @mermaid-js/mermaid-cli -i diagrams/*.mmd -o diagrams/`.

---

## External Dependencies

| Package | Purpose |
|---------|---------|
| `pg` | PostgreSQL client |
| `pgvector` | Vector embeddings for semantic search |
| `zod` | Config validation |
| `@opencode/plugin` | OpenCode plugin types |

---

## Affected Systems

- **OpenCode core**: Plugin registers tools, hooks, subagents
- **PostgreSQL**: External DB survives reinstalls (unlike built-in SQLite)
- **Agent context**: Memories injected via priming + context recall
- **Background processing**: Subconscious runs distillation periodically
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
| `src/context-compactor.ts` | Compresses tool outputs for context window. Budget cap, expandable refs, telemetry. | `ContextCompactor` class, `createContextCompactor()` |
| `src/tool-distiller.ts` | Distills tool activity into structured summaries | `ToolDistiller` class |
| `src/hooks/auto-docs.ts` | Auto-updates live docs on file edits, flushes on session end. Noise guard: dedup, grouping, ignored paths, caps, config toggle. | `queueDocUpdate()`, `flushDocUpdates()`, `isIgnoredPath()`, `DEFAULT_AUTO_DOCS_CONFIG`, `resetFlushedFlag()` |
| `src/hooks/doc-analyzer.ts` | LLM-powered code change analyzer; categorizes changes and updates all live docs (SYSTEM_MAP, DECISIONS, DEBUG_NOTES, DEBUG_NOTES, AGENT_MEMORY, RUNBOOK) | `autoDocumentChange()`, `analyzeChange()`, `updateAllDocs()` |
| `src/database.ts` | PostgreSQL schema + migrations (project_id, tracking fields) | `migrateProjectIsolation()` |
| `src/hooks/tool-execute.ts` | Tool execution hook — logs to memory + queues doc updates | `registerToolExecuteHook()` |
| `src/hooks/system-transform.ts` | System prompt transformation hook | `registerSystemTransformHook()` |
| `src/hooks/session-compaction.ts` | Session compaction hook | `registerSessionCompactionHook()` |

---


**src/new-feature.ts**
- Exports: none
- Imports: 
- Type: source

**src/new-feature.ts**
- Exports: none
- Imports: 
- Type: source

**src/new-feature.ts**
- Exports: none
- Imports: 
- Type: source

**src/new-feature.ts**
- Exports: none
- Imports: 
- Type: source

**src/new-feature.ts**
- Exports: none
- Imports: 
- Type: source

**src/new-feature.ts**
- Exports: none
- Imports: 
- Type: source

**src/a.ts**
- Exports: none
- Imports: 
- Type: source

**src/b.ts**
- Exports: none
- Imports: 
- Type: source

**src/a.ts**
- Exports: none
- Imports: 
- Type: source

**src/real-file.ts**
- Exports: none
- Imports: 
- Type: source

**src/new-feature.ts**
- Exports: none
- Imports: 
- Type: source

**src/a.ts**
- Exports: none
- Imports: 
- Type: source

**src/b.ts**
- Exports: none
- Imports: 
- Type: source

**src/a.ts**
- Exports: none
- Imports: 
- Type: source

**src/real-file.ts**
- Exports: none
- Imports: 
- Type: source
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
- `last_accessed_at` TIMESTAMPTZ
- `access_count` INTEGER DEFAULT 0
- `archived_at` TIMESTAMPTZ
- `project_id` TEXT — nullable (NULL = legacy/global)
- `embedding` VECTOR(1536) — for semantic search (pgvector)

**Indexes**: GIN on tags, IVFFLAT on embedding, BTREE on type/importance/created_at, BTREE on project_id, BTREE on (project_id, type, created_at)

---

## Project Isolation (Phase 5)

**Default behavior**: Memory recall is scoped to the current project only.
- Project ID = normalized workspace root path (stable hash)
- `NULL` project_id = legacy/global memories (preserved, not deleted)
- Global/legacy search requires explicit opt-in (`searchMode: 'global'`)

**Recall priority**:
1. Current project memories (exact project_id match)
2. Legacy/global memories (NULL project_id) — only if high importance or explicitly requested
3. Global memories — only with explicit opt-in

**Tables updated**: `memories`, `session_contexts` with nullable `project_id` columns + indexes.

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
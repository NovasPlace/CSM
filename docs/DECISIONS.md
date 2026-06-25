# DECISIONS.md

## Architecture Decisions

### 1. PostgreSQL over SQLite (External DB)
- **Decision**: Use PostgreSQL as primary memory store
- **Why**: Survives OpenCode reinstalls; built-in SQLite at `~/.config/opencode/` gets wiped
- **Trade-off**: Requires running PostgreSQL instance (Docker/local)
- **Status**: ✅ Implemented — confirmed survival across reinstall (Jun 25)

### 2. Adapter Boundaries (Database Class)
- **Decision**: Encapsulate all SQL in `Database` class (`src/database.ts`)
- **Why**: Single migration point; swap backend if needed; testable
- **Trade-off**: Slight abstraction overhead
- **Status**: ✅ Implemented

### 3. Semantic Search via pgvector
- **Decision**: Store embeddings in `memories.embedding` (VECTOR(1536))
- **Why**: Enables `memory_search` with semantic similarity, not just keywords
- **Trade-off**: Requires pgvector extension; embedding generation cost
- **Status**: ✅ Schema ready; embedding generation in extractor

### 4. Memory Types as Fixed Enum
- **Decision**: `conversation | workspace | repo | preference | lesson`
- **Why**: Predictable filtering; lessons get higher default importance (0.75)
- **Trade-off**: Less flexible than free-form tags
- **Status**: ✅ Enforced in `types.ts` and `config.ts`

### 5. Background Subconscious Processing
- **Decision**: `Subconscious` class runs distillation periodically, not on every turn
- **Why**: Avoids blocking user-facing operations; batches work
- **Trade-off**: Memories not instantly distilled
- **Status**: ✅ Implemented with configurable interval

### 6. Tool Distillation Separate from Memory Extraction
- **Decision**: `ToolDistiller` → structured summaries → `MemoryExtractor` → memories
- **Why**: Separation of concerns; distiller knows tools, extractor knows memory schema
- **Trade-off**: Two passes over tool output
- **Status**: ✅ Implemented

### 7. Context Compaction for Token Budget
- **Decision**: `ContextCompactor` compresses tool outputs before context injection
- **Why**: Prevents context window overflow in long sessions
- **Trade-off**: Loss of detail in compressed summaries
- **Status**: ✅ Implemented with risk labels (low/medium/high)

### 8. Priming at Session Start Only
- **Decision**: `PrimingEngine.prime()` runs once at session initialization
- **Why**: Avoids mid-session context shifts; predictable behavior
- **Trade-off**: New memories not available until next session
- **Status**: ✅ Implemented

### 9. Disabled Features by Default
- **Decision**: `autoDistill: false`, `semanticSearch: false` in default config
- **Why**: Opt-in for resource-intensive features; stable defaults
- **Trade-off**: Users must enable explicitly
- **Status**: ✅ In `config.ts:DEFAULT_CONFIG`

### 10. No Automation for Live Docs (Phase 1)
- **Decision**: Manual doc updates per turn; automation deferred to Phase 2
- **Why**: Validate value first; avoid premature abstraction
- **Trade-off**: Human discipline required
- **Status**: ✅ Completed — Phase 1 done

### 11. Auto-Documentation via Tool Hooks (Phase 2)
- **Decision**: Hook into `tool.execute.after` to queue doc updates; flush at session end via `dispose`
- **Why**: Eliminates manual discipline; docs stay in sync automatically
- **Trade-off**: Slight overhead on file ops; potential for stale docs if flush fails
- **Status**: ✅ Implemented — `src/hooks/auto-docs.ts`, integrated in `tool-execute.ts` + `index.ts`

### 12. Auto-Docs Noise Guard (Phase 3)
- **Decision**: Filter auto-doc updates with: ignored paths (`docs/`, `dist/`, `node_modules/`, `coverage/`, `.git/`), deduplicate repeated edits to same file, group multiple edits into single changelog entry, cap max entries per session (50), cap max entry length (500 chars), config toggle `autoDocs.enabled`
- **Why**: Prevents recursive loops, changelog spam, meaningless entries; keeps docs signal-to-noise high
- **Trade-off**: Slight complexity; some minor edits won't appear individually
- **Status**: ✅ Implemented — `src/hooks/auto-docs.ts` + 20 tests in `test/auto-docs.test.ts`

### 13. Project Isolation for Memory Hygiene (Phase 5)
- **Decision**: Add nullable `project_id` to `memories` and `session_contexts`; default recall scoped to current project; legacy NULL project_id memories preserved; global/legacy search requires explicit opt-in
- **Why**: Prevents cross-project memory pollution (Locus ↔ OpenCode plugin ↔ game projects); 14k+ memories need scope
- **Trade-off**: Migration complexity; nullable column for backward compatibility
- **Status**: ✅ Schema migration in `database.ts`; query paths updated in `MemoryManager`, `ContextRecall`, `index.ts`
- **Project ID**: Stable hash of normalized workspace root path (local-first, no Git dependency)
- **Recall modes**: `project` (default) | `legacy` (NULL project_id only) | `global` (explicit opt-in)
- **Retention**: Not automated yet — tracking fields added (`last_accessed_at`, `access_count`, `archived_at`), policy design in docs only
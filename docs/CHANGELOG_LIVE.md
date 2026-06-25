# CHANGELOG_LIVE.md

## Development Log

### 2026-06-25 — Phase 4: Live Documentation Visuals (Mermaid)
- **Files created**: `docs/diagrams/module-graph.mmd`, `docs/diagrams/data-flow.mmd`, `docs/diagrams/memory-pipeline.mmd`, `docs/diagrams/auto-docs-flow.mmd`, `docs/diagrams/compaction-rollover-flow.mmd`
- **Files changed**: `docs/SYSTEM_MAP.md` (diagram links), `README.md` (full feature list), `docs/CHANGELOG_LIVE.md` (this entry)
- **Why**: Visual debugging aid per Phase 4 plan; Mermaid diagrams are low-risk, GitHub-readable, embeddable later
- **Verification**: Build passes, 68 tests pass, diagrams render in GitHub

### 2026-06-25 — Phase 3: Auto-Docs Hardening (Noise Guard)
- **Files created**: `test/auto-docs.test.ts` (20 tests)
- **Files changed**: `src/hooks/auto-docs.ts` (noise guard: dedup, grouping, ignored paths, caps, config), `src/config.ts` (AutoDocsConfig), `src/types.ts` (AutoDocsConfig export)
- **Why**: Prevent doc spam, recursive loops, meaningless entries; make auto-docs useful not noisy
- **Verification**: Build passes, 68 tests pass (48 original + 20 new)

### 2026-06-25 — Phase 2: Auto-Documentation Hooks
- **Files created**: `src/hooks/auto-docs.ts`
- **Files changed**: `src/hooks/tool-execute.ts` (import + queue call), `src/index.ts` (import + flush on dispose)
- **Why**: Turn live docs from manual rule into runtime behavior; docs update automatically on every file edit
- **Verification**: Build passes, 48 tests pass

### 2026-06-25 — Phase 1: Live Documentation
- **Files created**: `docs/SYSTEM_MAP.md`, `docs/CHANGELOG_LIVE.md`, `docs/DECISIONS.md`, `docs/DEBUG_NOTES.md`, `docs/AGENT_MEMORY.md`, `docs/RUNBOOK.md`
- **Why**: Project explains itself; docs separate from memory; durable human-readable truth
- **Verification**: All 6 files exist, populated from actual repo state

### 2026-06-24 — Initial Plugin Setup
- Core plugin architecture with PostgreSQLite
- Memory manager, extractor, recall, distiller, compactor
- PostgreSQL + pgvector integration
- Context cache, checkpoints, goals
- 48 passing tests
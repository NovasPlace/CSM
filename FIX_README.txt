CSM TOOL_REF compaction fix

Primary fix
- Protect every tool result produced after the latest user message. Current-turn file reads, git commands, and other tool outputs remain readable by the agent.
- Filter existing TOOL_REF/[TOOL_REF]/[COMPACTED] results before they enter compaction.
- Make ContextCompactor itself idempotent for direct callers.
- Use the host's numeric state.time.compacted timestamp shape.
- Fail safe when no user-turn boundary or stable tool timestamp is available.
- Apply budget-cap mutation after final compaction selection so telemetry matches actual message mutation.

Additional hardening
- Replaced a permission-based auto-docs failed-flush test with a deterministic EISDIR failure and verified restoration ordering when a newer update is queued concurrently.

Verification
- TypeScript build: PASS
- TypeScript no-emit check: PASS
- ESLint src: PASS with the existing 7 opentui.d.ts warnings
- Focused compaction/hook tests: 27 passed, 0 failed
- Auto-docs repair tests: 38 passed, 0 failed, 1 skipped
- Full repository suite could not be completed in this Linux extraction because better-sqlite3 lacked a Linux native binding and PostgreSQL was unavailable at 127.0.0.1:5432.

Apply
  git apply csm-tool-ref-compaction-fix.patch

Or copy the files from csm-tool-ref-fix-files.zip into the repository root, preserving paths, then run:
  npm run build
  npm run typecheck
  npm run lint:src

## Phase 8B — Re-entry Live Enablement Controls

**Status:** Spec captured. Not started. Gated on explicit operator go-ahead.

### Goal
Allow explicit operator-controlled activation of re-entry injection while preserving
preview-only as the default.

### Hard constraints
- Default remains preview-only.
- No synthetic first-turn injection.
- System prompt augmentation only.
- Explicit enable flag required.
- `csm_reentry_preview` must show what would inject before enabling.
- Injection must happen once per session.
- No mutation during transform.
- Full diagnostics required.

### Current state (end of Phase 8A)
- `ReEntryProtocol` already has the injection machinery: `buildBlock()` returns the block
  when `config.previewOnly === false`, else `null`.
- `system-transform.ts` already calls `buildBlock()` on first turn and pushes to
  `output.system` when a block is returned. So the *switch* is effectively
  `config.previewOnly`. Phase 8B is about exposing that switch to the operator safely.
- `csm_reentry_preview` (Phase 8A) reports what **would** inject — already satisfies the
  "show what would inject before enabling" constraint.

### Likely implementation surface (for planning, not committed)
1. Config / env control
   - `CSM_REENTRY_PREVIEW_ONLY` (default `true`); `false` enables injection.
   - Resolve from `PluginConfig` so restart picks it up.
2. One-time injection guarantee
   - `ctx.state.reentryInjected: Set<string>` already tracks this (set in
     `system-transform.ts`). Verify it cannot double-inject on reconnect/resume.
3. Ordering
   - Block must appear after context brief, before living-state advisory
     (already wired in `system-transform.ts`).
4. Diagnostics
   - `csm_reentry_preview` and live injection config must agree
     (same source of truth: `ReEntryProtocol.config`).

### Tests (from spec)
- Default preview-only does not inject.
- Enable flag injects once.
- Re-entry block appears before living state advisory.
- Repeated turns do not duplicate injection.
- Missing state degrades gracefully.
- `csm_reentry_preview` agrees with live injection config.

### Acceptance line
Phase 8B is successful when an operator can flip one explicit flag and see the re-entry
block actually injected once per session, with `csm_reentry_preview` reporting the same
intent beforehand — and everything still defaults to preview-only.

---

**Last Updated:** 2026-07-08
**Phase:** 8B (spec only)
**Status:** Ready to start on explicit request

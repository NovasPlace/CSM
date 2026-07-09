# Phase 9A Live Validation

**Date:** 2026-07-08
**Status:** PASS

## Validation Results

### 1. Fresh session starts cleanly
- `csm_onboard_agent` tool produces 10 sections, ~1443 tokens
- All sections return valid shape (section, status, source, content)
- No crashes, no unhandled errors

### 2. First-turn injection only
- `onboardingInjected` Set tracks per-session injection
- system-transform.ts checks `!ctx.state.onboardingInjected?.has(sessionId)` before injecting
- Set.add() called immediately after check, preventing race conditions

### 3. Injection after re-entry
- system-transform.ts order: context brief → lesson constraints → re-entry block → **onboarding packet** → advisory block
- Onboarding appears after re-entry, before advisory

### 4. All 10 sections present
```
identity-brief:       ready
project-continuity:   ready
phase-checkpoint:     ready
constraints:          ready
relevant-memories:    ready
promoted-beliefs:     ready
advisories:           ready
tool-guidance:        ready
handoff-state:        ready
readiness-summary:    ready
```

### 5. Missing/degraded providers show status markers
- DB-down simulation: 7/10 sections degraded, 3 still ready (tool-guidance, identity-brief, constraints)
- Status markers: `[✓]` ready, `[~]` partial, `[⚠]` degraded, `[✗]` missing
- Degraded sections include warning text explaining failure reason

### 6. 1200-char cap respected
- formatOnboardingBlock output: 1443 tokens (~5772 chars untrimmed)
- capTrimLevel=minimal trims to 1200 chars in system-transform.ts
- Section headers preserved during trimming

### 7. AGENTS.md parsed correctly
- Role: `software-engineering-agent`
- Operating mode: `cross-session memory persistence active`
- Progress: Phase 7A-8D completed, Phase 9A in progress
- Constraints: PostgreSQL-only, no destructive changes, approval boundaries
- Key decisions: 12 decisions extracted

### 8. Handoff state reads journal/checkpoints
- Work journal: last session ID, result summary, files touched, error summary
- Checkpoints: reads .csm/ directory when present
- Missing .csm/ directory handled gracefully (no crash)

### 9. DB-down simulation
- All 3 DB queries (memories, beliefs, advisories) throw
- Provider try/catch catches each failure
- Sections degrade to `[⚠]` with warning text
- Packet still produced with 10 sections
- Readiness summary notes degraded sections

### 10. No repeated injection
- `onboardingInjected` Set persists across turns in same session
- Second turn: `!ctx.state.onboardingInjected.has(sessionId)` returns false → no injection
- Different sessions get independent tracking

## Schema Fixes Applied

Live validation revealed 3 schema mismatches between provider SQL and actual DB:

| Provider | Expected Column | Actual Column | Fix |
|----------|----------------|---------------|-----|
| relevant-memories | `status = 'active'` | `is_active = true` | Changed WHERE clause |
| advisories | `evidence_count` | `success_count + failure_count` | Computed column |
| handoff-state | `work_summary`, `next_step` | `result_summary`, `error_summary` | Changed SELECT + labels |

## Bugs Fixed

1. **CRLF line ending**: `extractSection` now normalizes `\r\n` → `\n` before regex matching
2. **fs.readdirSync crash**: handoff provider now checks `fs.existsSync` before reading `.csm/` directory
3. **Readiness count**: shows `10/10` instead of `9/9` (passes totalSections to provider)

## Test Coverage

- 28 new tests in `test/agent-onboarding.test.ts`
- 14 test groups covering all 10 providers + orchestrator + formatter + injection guard
- Regression test: "degraded provider must never prevent startup injection"
- All 903/903 tests pass
- Lint: 7 warnings (opentui.d.ts only, unchanged)

## Conclusion

The onboarding system is verified live. It:
- Produces useful startup context from existing systems
- Degrades gracefully when parts are missing/broken
- Injects once per session, after re-entry
- Never crashes the startup sequence
- Respects token budget with cap trimming

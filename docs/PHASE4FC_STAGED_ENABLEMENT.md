# Phase 4F-C: Staged Enablement Guide

## Goal
Prove the advisory living-state block helps continuity without steering the agent too hard.

## Stage 1 — Local Opt-In Only

### Config
```bash
CSM_LIVING_STATE_INJECT_ADVISORY=true
CSM_LIVING_STATE_MAX_ADVISORY_CHARS=1200
```
Keep `CSM_LIVING_STATE_PREVIEW_ONLY=true` and `CSM_LIVING_STATE_ENABLED=true` (defaults).

The block is still `previewOnly` (no promotion, no memory writes).

### Verification
Run `csm_living_state_debug` to confirm the block is assembled. It should show:
```
Block produced: true
Sections: internalState ✓, recentSignals ✓, capabilityNotes ✓, candidateBeliefs ✓, warnings (if any)
```

## Stage 2 — Observation Run

Run several real sessions with advisory enabled. After each session, use diagnostic tools to inspect:

### Inspection commands
| Tool | What it shows |
|------|---------------|
| `csm_living_state_preview` | Current pipeline state (packets, candidates, capabilities, beliefs) |
| `csm_living_state_debug` | Advisory block assembly decisions — which sections appeared/omitted, trim decisions, packet source |
| `csm_belief_knowledge` | Consolidated beliefs with evidence refs |
| `csm_self_model` | Capability confidence/uncertainty/drift |

### Log checklist for each session
- [ ] Advisory block length (vs `maxAdvisoryBlockChars`)
- [ ] Which sections appeared in the block
- [ ] Which sections were trimmed/omitted
- [ ] Whether `warningsCondensed` was triggered
- [ ] Whether `hardTruncated` was triggered
- [ ] Latest packet source (entryType, outcome, untrusted status)
- [ ] Whether warnings were present
- [ ] Final injected prompt order (context brief first, advisory block after)
- [ ] No new durable beliefs created from advisory output

### Behavioral observations
- Does the advisory block improve turn-to-turn continuity?
- Does it add noise or distraction?
- Are warnings useful or alarming?
- Does the model ever cite advisory block content as fact?

## Stage 3 — Decision Point

After observation, decide:

### If the block helps
- Leave `injectAdvisoryBlock=true` in your local environment
- Tune `maxAdvisoryBlockChars` based on typical block length
- Consider increasing budget if sections are frequently omitted

### If the block adds noise
- Keep `injectAdvisoryBlock=false` (current default for everyone)
- The pipeline still runs; `csm_living_state_preview` still available
- The state layer exists for future use

### Default-on for others
- Not yet. This is a local experiment only.
- Default-on requires: stable trimming behavior, proven utility across multiple sessions, no model-citation issues.

## For Your Environment

`injectAdvisoryBlock=true` is safe to enable locally because:
1. Every block starts with `Status: preview, not durable truth.`
2. No imperative/prohibition/absolutist language present.
3. The block is appended after the context brief (lower priority).
4. No memory writes or promotion occur.
5. Budget enforcement prevents runaway verbosity.
6. `Warnings:` survive longest through trimming.

## Acceptance Criteria Verification

| # | Criterion | Status |
|---|-----------|--------|
| 1 | Advisory block never appears unless `injectAdvisoryBlock=true` | ✓ Tested (disabled config → null) |
| 2 | Block clearly labeled as preview / not durable truth | ✓ Tested (disclaimer present) |
| 3 | No imperative policy language | ✓ Tested (no "You must"/"Do not"/"Always") |
| 4 | Warnings survive trimming as long as possible | ✓ Tested (beliefs→caps→signals dropped first) |
| 5 | Prompt order: context brief → advisory block → boundary | ✓ Structural (push ordering after context brief) |
| 6 | Debug tool explains section presence/omission | ✓ `csm_living_state_debug` shows `sections` + `omissions` |
| 7 | Tests cover enabled, disabled, empty, over-budget, warning-only | ✓ 17 tests across all states |

## Diagnostic Tool Reference

`csm_living_state_debug` output includes:
- Config status (enabled, injectAdvisoryBlock, maxChars)
- Whether block was produced and its length
- Per-section status: not available / ✓present / ⚠OMITTED
- Condensed/hard-truncated flags
- Budget vs final length
- Raw block text
- Packet source (entryType, dominantEmotion, stance, outcome, untrusted flag)
- Raw preview counts (packets, candidates, capabilities, beliefs, warnings)
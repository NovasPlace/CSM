# Phase 4G: Belief Promotion Pipeline

**Status**: Complete
**Date**: 2026-07-08
**Tools**: `csm_belief_promotion_scan` (read-only, 31st tool), `csm_belief_promote` (explicit promotion)
**Tests**: 794/794 (10 new Phase 4G tests)

## Overview

Phase 4G closes the loop from observed experience → belief candidate → reviewed promotion → durable memory. The pipeline is **explicit and gated** — no silent promotion, no destructive mutation, no candidate deletion.

## Lifecycle

```
Experience Packets
       ↓
Belief Promotion Scanner (csm_belief_scan)
       ↓
Unified Candidate Queue (memory_candidate_queue)
       ↓
Promotion Scan (csm_belief_promotion_scan)     ← READ-ONLY
       ↓
Promotion-Ready Candidates
       ↓
Explicit Promotion (csm_belief_promote)         ← WRITES
       ↓
Durable Memory with Provenance
```

### Stages

1. **Scan**: `csm_belief_scan` reads experience packets, groups by pattern fingerprints, maps to candidate types, and writes candidates to the queue with confidence scores.

2. **Promotion Scan**: `csm_belief_promotion_scan` evaluates pending candidates against thresholds and reports what WOULD be promoted, blocked, or needs review. **Read-only. No writes. No candidate status mutation.**

3. **Explicit Promotion**: `csm_belief_promote` promotes candidates that pass all threshold checks. Creates durable memories with full provenance. Marks candidates as `applied` to prevent re-promotion (idempotent).

## Two Tools — Trust Boundary

| Tool | Writes? | Purpose |
|------|---------|---------|
| `csm_belief_promotion_scan` | **Never** | Inspect what would be promoted and why |
| `csm_belief_promote` | Yes (explicit) | Actually promote promotion-ready candidates |

The separation is intentional. A future agent can safely call `csm_belief_promotion_scan` without risk of mutation. The scan tool internally uses the same evaluator as the promote tool but forces `dryRun: true` regardless of configuration.

## Promotion Decisions

The evaluator produces one of these decisions for each candidate:

| Decision | Meaning |
|----------|---------|
| `promote` | All thresholds passed — candidate is promotion-ready |
| `skip_low_confidence` | Confidence below threshold |
| `skip_low_reinforcement` | Reinforcement count below threshold |
| `skip_low_evidence` | Evidence refs below threshold |
| `skip_low_sessions` | Not enough distinct sessions observed |
| `skip_dedup_match` | Similar belief already exists in memory |
| `needs_review` | Contradiction detected — requires human/agent review |

## Thresholds

Default thresholds (overridable per-scan via params):

| Threshold | Default | Description |
|-----------|---------|-------------|
| `minConfidence` | 0.70 | Minimum confidence score (0-1) |
| `minReinforcement` | 3 | Minimum reinforcement count |
| `minEvidenceRefs` | 2 | Minimum evidence reference count |
| `minSessions` | 1 | Minimum distinct sessions |
| Contradicted | 0 | Contradicted candidates are blocked |

Relaxed mode (`relaxed: true`) lowers thresholds for testing/dev:
- `minConfidence`: 0.50
- `minReinforcement`: 1
- `minEvidenceRefs`: 1

## Provenance

Every promoted belief creates a durable memory with this metadata:

```json
{
  "promotion_source": "belief_promotion_engine",
  "candidate_ids": [42, 43],
  "evidence_packet_ids": [1001, 1002, 1003],
  "evidence_count": 3,
  "promotion_confidence": 0.85,
  "promoted_at": "2026-07-08T...",
  "supersedes": null,
  "reversible": true,
  "candidate_type": "candidate_preference",
  "threshold_profile": { "minConfidence": 0.70, ... }
}
```

## Idempotency

- After promotion, candidate status changes from `pending` → `applied`
- Re-running `csm_belief_promote` does not re-promote applied candidates
- Applied candidates remain in the queue for audit trail (never deleted)

## No Silent Promotion

The pipeline is **explicitly gated**:
- `csm_belief_promotion_scan` cannot write, even if misconfigured
- `csm_belief_promote` requires `dryRun: false` to actually promote
- `CSM_BELIEF_PROMOTION_ENABLED=true` must be set in config
- Candidates are not auto-promoted at session end or during scans

## New Exports

| Export | Purpose |
|--------|---------|
| `beliefPromotionScanTool()` | Read-only scan tool factory |
| `beliefPromotionTool()` | Explicit promotion tool factory (existing) |
| `BeliefPromotionEngine` | Core evaluator + promoter (existing) |

## Test Coverage

10 new tests across 3 suites:

- **Idempotent promotion**: Re-running promotion does not re-promote applied candidates
- **Empty queue**: Clean empty result, not failure
- **Scan no-writes**: Scan tool creates zero memories, does not mutate candidate status
- **Scan reasoning**: Output includes decisions with reasoning
- **Scan disabled**: Returns graceful message when promotion is disabled
- **Scan empty queue**: Does not fail on empty queue
- **Tool registration**: Scan tool in CSM_TOOL_NAMES, tool count is 31

All 794 tests pass. Full suite green.

## Files

| File | Change |
|------|--------|
| `src/belief-promotion-tool.ts` | Added `beliefPromotionScanTool()` (read-only tool) |
| `src/hooks/tool-hooks.ts` | Registered `csm_belief_promotion_scan` |
| `src/tool-names.ts` | Added `csm_belief_promotion_scan` (31 tools) |
| `test/belief-promotion.test.ts` | 10 new tests |
| `test/continuity-report.test.ts` | Updated tool count assertion (30→31) |

## Usage

```bash
# Read-only scan: what would be promoted?
csm_belief_promotion_scan

# Scan with custom thresholds
csm_belief_promotion_scan --minConfidence=0.8 --minReinforcement=5

# Explicit promotion (writes)
csm_belief_promote

# Promotion with dry-run (backward compat)
csm_belief_promote --dryRun=true
```

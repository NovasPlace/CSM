# Phase 4F-A: Living State Runtime Loop Preview

## Architecture

```
┌──────────────────────────────────────────────────────┐
│              LivingStateRuntime.runPass()             │
│                                                       │
│  1. scan() experience_packets → memory_candidate_queue │
│  2. snapshot → updateAll() → diff self_model_capabilities│
│  3. consolidate() → belief_knowledge_store             │
│  4. assemble LivingStatePreview                         │
│                                                       │
│   No context injection. No memory writes.              │
│   Failure isolation: each layer wrapped in try/catch.  │
└──────────────────────────────────────────────────────┘
```

## Orchestration, Not Duplication

`LivingStateRuntime` does NOT implement its own scanner, updater, or consolidator. It calls existing modules in order:

| Step | Module | Destination |
|------|--------|-------------|
| 1 | `BeliefPromotionScanner.scan()` | `memory_candidate_queue` |
| 2 | `SelfModelUpdater.updateAll()` + snapshot diff | `self_model_capabilities` |
| 3 | `BeliefKnowledgeConsolidator.consolidate()` | `belief_knowledge_store` |

## Config

```typescript
// src/types.ts
export interface LivingStateConfig {
  enabled: boolean;           // default true (CSM_LIVING_STATE_ENABLED)
  previewOnly: boolean;       // default true (CSM_LIVING_STATE_PREVIEW_ONLY)
  scanLookbackMinutes: number; // default 10
  maxScanPerType: number;      // default 10
  updateIntervalMs: number;    // default 60000
}
```

`previewOnly=true` is the hard safety. When true, the runtime loop runs but never injects into context or writes to durable memory.

## Tool: `csm_living_state_preview`

- `runPass=true` (default): runs full advisory pipeline → returns preview
- `runPass=false`: static snapshot without mutation

Preview includes:
- Recent packets scanned
- Candidate deltas (inserted, updated, by type)
- Self-model capabilities (confidence, uncertainty, evidence count, drift)
- Belief knowledge deltas (created, updated, total)
- Warnings (per-layer failure reporting)
- Guardrails summary (no injection, no memory writes, no promotion)

## Guardrails

- No automatic durable memory writes
- No prompt/context injection
- No direct promotion of candidates or beliefs
- No training
- Every preview claim backed by evidence refs from the source modules
- Failure in one advisory layer does not block others

## Acceptance Test Inventory (11 tests)

| Test | Verifies |
|------|----------|
| runtime pass calls all 3 modules in order | Orchestration |
| preview includes evidence refs via self-model | Provenance |
| disabled config returns empty, zero calls | Config gating |
| duplicate pass is idempotent (same methods called) | Idempotency |
| getPreview does not mutate | Read-only |
| scanner failure does not block self-model/consolidator | Layer isolation |
| warnings list populated on failure | Error reporting |
| previewOnly propagates from config | Config |
| tool returns all 5 sections + guardrails | Tool display |
| tool with runPass=false uses getPreview | Static path |
| tool does not write any data | Read-only guarantee |

## Next: Phase 4F-B

Context Brief Candidate Section — living state can appear as a clearly labeled advisory block in the context brief. That's when it starts affecting behavior.
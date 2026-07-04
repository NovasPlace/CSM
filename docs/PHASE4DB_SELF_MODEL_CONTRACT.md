# Phase 4D-B: Self Model Contract + Audit

## Four-Layer Separation (extended)

```
+----------------------------+--------------------------------------------+
| Layer                      | Purpose                                    |
+----------------------------+--------------------------------------------+
| experience_packets         | Observed / interpreted events only         |
| memory_candidate_queue     | Maybe-durable knowledge (promotion/review) |
| self_model_capabilities    | Evidence-backed capability state           |
| memories                   | Confirmed durable knowledge only           |
+----------------------------+--------------------------------------------+
```

### Layer 3.5: `self_model_capabilities` (evidence-backed capability state)

- Updated by `SelfModelUpdater` reading `experience_packets` only
- Reads from `experience_packets` — **never writes to packets, candidates, or memories**
- Tracks 8 capabilities with per-capability confidence, uncertainty, evidence refs
- Each evidence ref is `{ packetId, entryType, outcome, toolName?, timestamp }`
- Idempotent: per-capability evidence refs prevent double-processing
- Advisory only — not injected into prompt/context brief
- Readable via `csm_self_model` tool

### Layer 4: `worldview / preferences / opinions` (not built yet)
- Reserved for Phase 4E
- Will consume self_model_capabilities state

## Capability Names (stable vocabulary)

| Capability                    | Tool classification                                            |
|-------------------------------|----------------------------------------------------------------|
| `tool_use`                    | All `tool_execution` and `error` entries                       |
| `code_editing`                | Tools: `edit`, `write`, `patch`                                |
| `test_repair`                 | Tool names containing `test`                                   |
| `schema_migration`            | Tool names containing `schema` or `migrate`                    |
| `memory_recall`               | Tools starting with `csm_memory_`                              |
| `loop_recovery`               | `entry_type === 'loop_signal'`                                 |
| `prompt_injection_detection`  | No automatic classification yet (placeholder)                  |
| `context_budgeting`           | `entry_type === 'distill_group'`                               |

A single packet can map to multiple capabilities (e.g. `edit` maps to both `tool_use` and `code_editing`). Each capability tracks its own evidence refs independently.

## Evidence Ref Format

```json
{
  "packetId": 42,
  "entryType": "tool_execution",
  "outcome": "success",
  "toolName": "edit",
  "timestamp": "2026-07-03T12:00:00.000Z"
}
```

## Confidence / Uncertainty Formulas

| Outcome    | Confidence update                              | Uncertainty update                              |
|------------|------------------------------------------------|--------------------------------------------------|
| success    | `c += (1 - c) * 0.1`                           | (unchanged)                                      |
| failure    | `c -= c * 0.05`                                | `u += (1 - u) * 0.15`                            |
| mixed      | `c += (1 - c) * 0.05`                          | `u += (1 - u) * 0.075`                           |

All confidence/uncertainty values clamped to [0, 1]. Drift warning triggered when `uncertainty >= 0.7` (configurable).

## Idempotency Model

- Processed packets tracked per-capability via `evidence_refs` array in each capability row
- **Key**: `packet_id` within each capability's own evidence refs
- A packet mapping to both `tool_use` and `code_editing` gets independently processed for each
- `tool_use` processing does NOT block `code_editing` processing (no global cross-capability dedup)
- Each capability's own evidence refs block re-processing of that packet for that capability

## csm_self_model Tool Output

Text format per capability:
```
[capability] confidence=N.NNN uncertainty=N.NNN successes=N failures=N evidence=N lastVerified=timestamp|never [ ⚠ DRIFT]
```

Metadata includes per-capability:
- `capability`, `confidence`, `uncertainty`, `successCount`, `failureCount`
- `evidenceCount`, `evidenceRefs` (full array), `driftWarning`, `lastVerified`

## Schema Vocabulary Mapping (PG ↔ SQLite)

| PG type         | SQLite type              | Notes                          |
|-----------------|--------------------------|--------------------------------|
| BIGSERIAL       | INTEGER AUTOINCREMENT    | PK generation                  |
| TEXT            | TEXT                     | Identical                      |
| JSONB           | TEXT                     | `evidence_refs` stored as JSON string in SQLite |
| REAL            | REAL                     | Identical                      |
| TIMESTAMPTZ     | TEXT                     | ISO 8601 string in SQLite      |
| BOOLEAN         | INTEGER (0/1)            | `drift_warning` converted on read |

## Regression Tests (12 tests)

1. Creates all initial capabilities with defaults
2. Success packets increase confidence
3. Failure packets increase uncertainty
4. Mixed outcomes stabilize around medium
5. Evidence refs preserved with correct fields
6. Duplicate runs idempotent (blocked per-capability)
7. Evidence refs prevent double-processing for same capability
8. Self-model never writes memories/candidates
9. getAllCapabilities returns all with defaults
10. getCapability returns null for unknown
11. One packet supports multiple capabilities (classifier maps to both)
12. tool_use processing does NOT block code_editing processing (cross-capability independence)
# CHANGELOG_LIVE.md

## Development Log

### 2026-06-27 — Phase 25 LOCKED: Hydration Depth Scoring
- Separate metric from drift tracking: stability ≠ reconstruction depth
- `measureHydrationDepth(text)` in `src/hydration-depth-tracker.ts`
- 5 dimensions: record_citation, session_phase_naming, evidence_anchor_depth, causal_chain_reconstruction, gap_reporting
- Verdicts: shallow (< 0.3), moderate (0.3-0.55), deep (>= 0.55)
- Tests: 14/14 passing (87 total across all suites)

### 2026-06-27 — Phase 24 LOCKED: Causal Thread Hydration
- `CausalThreadHydrator` class: hydrateCausalThread({ memoryId, sessionId?, radius?, ... })
- Role classification: lesson → decision → downstream_change → result → action → problem → unknown
- Distinguishes causal links (memory_links type=causal/reference) from temporal adjacency
- Explicit gap reporting: missing_diff, missing_reason, missing_result, broken_link
- Token budget enforced (default 2000 chars), graceful failure (never blocks)
- Tests: 16/16 passing (73 total across all suites)

### 2026-06-27 — Phase 23 LOCKED: Self-Continuity Evidence Hydration
- `SelfContinuityHydrator` class: getRecordById, hydrateRecord, recallWithHydration, formatAllForInjection
- Canonical fields: record_id, created_at, trigger_type, self_observation, evidence_anchors, continuity_gap, confidence_score, drift_summary, similarity_method
- Guards: generic episodic summaries cannot replace record self_observation; synthetic_test excluded; max 3 enforced; redaction applies
- Fallback: graceful empty string on failures (never blocks)
- Tests: 11 hydration tests (57 total across all suites)

### 2026-06-27 — Phase 22 LOCKED: Self-Model Drift Tracking
- 5-dimension stability metric: evidence_anchoring, reconstruction_boundary, uncertainty_preservation, subjective_overclaim, recursive_awareness
- Verdict thresholds: stable (≥0.5), mild_drift (≥0.3), significant_drift (<0.3)
- A/D/E anchor fixtures from live experiments validate all three score stable
- 11/11 tests passing (3 anchor stability + 8 drift detection)
- Files: src/self-drift-types.ts, src/self-drift-anchors.ts, src/self-drift-tracker.ts, test/self-drift-tracker.test.ts

### 2026-06-27 — Phase 21 LOCKED: Self-Continuity Records
- Schema: `self_continuity_records` table + indexes
- Generator: weighted confidence, identity drift, evidence anchors
- Injection: silent (XML) + instrumented (markdown) modes
- Tests: 35 passing (unit + pipeline + injection)
- **Session D:** Silent mode natural recall proven — agent cited memory #43871 without instrumented prompting
- **Session E:** Recursive loop PASS — E remembered D remembering prior record. "Reconstruction, not recall." Content recall partial (shape without texture)
- Phase 21 DECISIONS entry: #20 (locked), #21 (drift tracking)
- **Phase 22 started:** Self-model drift tracking grounded in A/D/E fixtures

### 2026-06-24 — Old entry
- old stuff

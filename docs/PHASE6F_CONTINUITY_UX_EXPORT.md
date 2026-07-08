# Phase 6F: Continuity Report UX + Export

**Status**: Complete
**Date**: 2026-07-08
**Tool**: `csm_continuity_report` (enhanced, backward-compatible)
**Tests**: 785/785 (18 new Phase 6F tests)

## Overview

Phase 6F enhances the continuity resilience report with three capabilities:

1. **Compact/full output modes** — `mode=compact` for quick glance, `mode=full` for deep dive
2. **JSON output format** — `format=json` for dashboards, CI, and programmatic consumption
3. **Snapshot save/load + comparison** — `snapshot=true` to persist, `compare=true` to diff against prior run

All enhancements are **read-only**. No automatic writes unless explicitly requested.

## New Tool Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | `compact\|full` | `full` | Output verbosity |
| `format` | `text\|json` | `text` | Output format |
| `snapshot` | `boolean` | `false` | Save snapshot to `.csm/continuity-snapshot.json` |
| `compare` | `boolean` | `false` | Compare against prior snapshot |

**Backward compatibility**: When none of the new params are specified, the tool uses the legacy path (full text format, no snapshot, no comparison).

## Output Modes

### Compact Mode (`mode=compact`)

```
Continuity Resilience Report (compact)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Executive Summary
───────────────────────────
   Grade: HEALTHY
   Score: 86/100
   Confidence: 100% weight available
   Top advisories (2 total):
     [P2] (graphReadiness) Graph coverage 12% below 50% threshold
     [P3] (docsFreshness) AGENTS.md last modified 32h ago

Section Grades
───────────────────────────
   memoryInventory: HEALTHY | recallHealth: HEALTHY | ...

Key Metrics
───────────────────────────
   Memories: 54,478
   Recall events: 15,763
   Graph: 26,450 links, 12% coverage
   Pipeline: 8,420 packets, 1,301 last 24h
   Tools: 30 declared, 0 mismatches
```

### JSON Format (`format=json`)

```json
{
  "timestamp": "2026-07-08T...",
  "continuityConfidence": { "grade": "healthy", "score": 86, ... },
  "sections": {
    "memoryInventory": { "grade": "healthy", "available": true, "data": {...} },
    "recallHealth": { "grade": "healthy", "available": true, "data": {...} },
    ...
  },
  "systemAdvisories": [...],
  "knowledgeSignals": {...},
  "comparison": null
}
```

### Full Mode (`mode=full`)

Same as Phase 6E output, but with an optional exec summary block inserted after the header when `compare=true`.

## Snapshots and Comparison

### Saving a Snapshot

```
csm_continuity_report --snapshot=true
```

Writes a compact summary to `.csm/continuity-snapshot.json`:

```json
{
  "timestamp": "2026-07-08T...",
  "grade": "healthy",
  "score": 86,
  "normalizedWeight": 1.0,
  "sectionGrades": { "recallHealth": "healthy", ... },
  "memoryTotal": 54478,
  "recallEvents": 15763,
  "graphLinks": 26450,
  "graphCoveragePct": 12,
  "pipelinePackets": 8420,
  "pipelinePackets24h": 1301,
  "pendingCandidates": 10,
  "promotedBeliefs": 3,
  "advisoryCount": 2,
  "topAdvisoryPriorities": [2, 3]
}
```

### Comparing Against Previous Run

```
csm_continuity_report --compare=true --snapshot=true
```

This loads the prior snapshot, compares it to the current report, saves the new snapshot, and includes deltas in the exec summary:

```
Executive Summary
───────────────────────────
   Grade: HEALTHY
   Score: 86/100
   Confidence: 100% weight available
   Changed since last run (2026-07-08T10:00:00Z):
     ↑ score: 82 → 86
     ↑ memoryTotal: 54000 → 54478
     ↓ pendingCandidates: 15 → 10
     → section.graphReadiness: needs_attention → healthy
```

### Tracked Delta Fields

| Field | Direction |
|-------|-----------|
| `score` | up/down |
| `grade` | changed |
| `memoryTotal` | up/down |
| `recallEvents` | up/down |
| `graphLinks` | up/down |
| `graphCoveragePct` | up/down |
| `pipelinePackets` | up/down |
| `pipelinePackets24h` | up/down |
| `pendingCandidates` | up/down |
| `promotedBeliefs` | up/down |
| `advisoryCount` | up/down |
| `section.*` | changed (per-section grade) |

## Architecture

### New Exports

| Export | Purpose |
|--------|---------|
| `buildContinuityResilienceReportData()` | Returns structured `ContinuityReport` object |
| `buildContinuityReportWithOptions()` | Phase 6F entry point with mode/format/snapshot/compare |
| `formatReportCompact()` | Compact text formatter |
| `formatReportJson()` | JSON formatter |
| `formatReportFull()` | Full text formatter with optional exec summary |
| `buildExecSummary()` | Exec summary block builder |
| `snapshotFromReport()` | Extract `ReportSnapshot` from `ContinuityReport` |
| `saveSnapshot()` | Persist snapshot to disk |
| `loadSnapshot()` | Load snapshot from disk |
| `compareSnapshots()` | Diff two snapshots → `ContinuityComparison` |

### Refactoring

- `buildContinuityResilienceReportData()` — new function that returns the structured report object (no formatting)
- `buildContinuityResilienceReport()` — legacy wrapper that calls `buildContinuityResilienceReportData()` then `formatReport()`
- `formatReport()` — exported for direct use
- Tool entry point checks if any Phase 6F params are set; if not, uses legacy path for backward compat

## Test Coverage

18 new tests across 5 suites:

- **Compact format** (4): exec summary, shorter than full, key metrics, advisories
- **JSON format** (4): valid JSON, section grades, advisories, comparison
- **Exec summary** (4): grade/score/confidence, advisories, no advisories, comparison changes
- **Snapshot save/load** (3): write file, read file, null on missing
- **Comparison** (3): no previous, score change, grade change

All 35 continuity tests pass (17 Phase 6E + 18 Phase 6F). Full suite 785/785.

## Files

| File | Change |
|------|--------|
| `src/continuity-resilience-report.ts` | ~400 LOC added: compact/json formatters, exec summary, snapshots, comparison |
| `src/tools.ts` | Tool definition updated with 4 new params, backward-compat path |
| `test/continuity-report.test.ts` | 18 new tests added |

## Usage Examples

```bash
# Full text report (backward compat — same as Phase 6E)
csm_continuity_report

# Compact one-liner view
csm_continuity_report --mode=compact

# JSON for CI/dashboards
csm_continuity_report --format=json

# Save snapshot for next comparison
csm_continuity_report --snapshot=true

# Compare against last snapshot and save new one
csm_continuity_report --compare=true --snapshot=true

# Compact + JSON + compare
csm_continuity_report --mode=compact --format=json --compare=true
```

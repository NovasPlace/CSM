# Phase 6E: Continuity Resilience Report

**Status**: Complete  
**Date**: 2026-07-08  
**Tool**: `csm_continuity_report` (30th tool registered)

## Overview

Phase 6E implements a read-only continuity resilience dashboard that provides a single-glance view of the full CSM stack health. It evaluates 7 weighted sections, computes a composite confidence score, derives system advisories, and produces actionable diagnostics.

## Sections Evaluated

| Section | Weight | Data Source | Description |
|---------|--------|-------------|-------------|
| `memoryInventory` | 10% | `listMemories()` | Memory counts by type/status |
| `recallHealth` | 30% | `RecallQualityAuditReportBuilder` | Recall telemetry quality |
| `graphReadiness` | 15% | `getGraphLinks()` | Link coverage and connectivity |
| `pipelineStatus` | 15% | `ExperiencePacketCreator` | Packet flow, candidates, promotions |
| `livingState` | 10% | `LivingStateRuntime.getPreview()` | Advisory block assembly state |
| `docsFreshness` | 10% | File system check | Key documentation exists |
| `toolRegistry` | 10% | `CSM_TOOL_NAMES` | Declared vs registered tools |

## Composite Scoring

### Weights

```typescript
const WEIGHTS: Record<string, number> = {
  recallHealth: 0.30,      // Most critical for continuity
  graphReadiness: 0.15,     // Link connectivity
  pipelineStatus: 0.15,     // Experience flow
  memoryInventory: 0.10,    // Storage baseline
  livingState: 0.10,        // Runtime state
  docsFreshness: 0.10,      // Documentation
  toolRegistry: 0.10,       // Tool consistency
};
```

### Re-normalization

When sections are unavailable, their weight is redistributed proportionally:

```
normalizedWeight = sum(available section weights)
reWeightedScore = sum(available section scores) / normalizedWeight
```

If less than 50% of weight is available, overall grade becomes `unknown`.

### Grade Calculation

| Score Range | Grade |
|-------------|-------|
| 90-100 | `healthy` |
| 70-89 | `needs_attention` |
| 0-69 | `degraded` |
| N/A | `unknown` |

## System Advisories

Advisories are derived from section states (0% weight). Priority levels:

- `critical` (1): Sections with `degraded` grade
- `warning` (2): Sections with `needs_attention` grade
- `info` (3): Low link coverage, low recall confidence, missing docs, tool mismatches

## Tool Usage

```
# Full report with diagnostics
csm_continuity_report

# Custom scope
csm_continuity_report --projectId my-project
```

### Response Structure

```typescript
interface ContinuityReport {
  // Section results
  memoryInventory: SectionResult<MemoryInventoryData>;
  recallHealth: SectionResult<RecallHealthData>;
  recallScore: RecallQualityAuditScore | null;
  graphReadiness: SectionResult<GraphReadinessData>;
  pipelineStatus: SectionResult<PipelineStatusData>;
  livingState: SectionResult<LivingStateData>;
  docsFreshness: SectionResult<DocsFreshnessData>;
  toolRegistry: SectionResult<ToolRegistryData>;
  
  // Derived sections (not weighted)
  systemAdvisories: SystemAdvisory[];
  knowledgeSignals: Record<string, unknown>;
  
  // Composite result
  continuityConfidence: {
    grade: ContinuityGrade;
    score: number;           // 0-100
    normalizedWeight: number; // sum of available weights
    sectionGrades: Record<string, ContinuityGrade>;
  };
}
```

## Known Limitations

- **Recall health**: Degrades to `unknown` on SQLite (requires PG telemetry)
- **Knowledge signals**: Placeholder for future belief knowledge integration
- **Graph metrics**: Basic link coverage only, no centrality analysis

## Implementation Notes

- All section collectors are exported for testability
- `computeContinuityConfidence` is a pure function (no side effects)
- Tool registry uses `CSM_TOOL_NAMES` from `src/tool-names.ts` (breaks circular dependency)
- Lint baseline: 96 warnings (within `max-warnings=96`)

## Files

| File | Purpose |
|------|---------|
| `src/continuity-resilience-report.ts` | Main module (~650 LOC) |
| `src/tool-names.ts` | Central tool name list (extracted to break cycle) |
| `test/continuity-report.test.ts` | 17 contract tests |
| `src/tools.ts` | Registers `continuityReportTool` |
| `src/hooks/tool-hooks.ts` | Wires tool into hook system |

## Test Coverage

17 tests covering:
- Composite scoring with all/missing sections
- Grade propagation
- Section re-normalization
- Advisory derivation
- Docs freshness detection
- Tool registry mismatch detection
- Confidence tolerance
- Priority sorting

All tests pass: `npx tsx --test test/continuity-report.test.ts`

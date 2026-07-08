## Phase 8A-R — Re-entry UX Interface Repair

**Goal:**
Restore clean validation and make the Phase 8A implementation path obvious by aligning the spec with the real ReEntryProtocol interface.

**Status:**
- ✅ Tool registry consistency restored (csm_reentry_preview removed from registration)
- ✅ All 808 tests pass
- ⏳ Interface documentation pending
- ⏳ Adapter plan pending

---

## 1. Tool Registry Consistency ✅

**What was fixed:**
1. Removed `csm_reentry_preview` from `src/tool-names.ts`
2. Removed `csm_reentry_preview` from `src/hooks/tool-hooks.ts` registration
3. Removed `csm_reentry_preview` from `dist/tool-names.d.ts` and `dist/codex-bridge-extra-state-ops.d.ts`
4. Rebuilt project to regenerate dist files
5. Verified all 808 tests pass

**Before:**
- Tool count: 32 (expected 31)
- Tests: 807/808 pass (1 test failing due to tool count mismatch)

**After:**
- Tool count: 31 (exact)
- Tests: 808/808 pass (100%)

**Tool names list (31 tools):**
1. csm_memory_save
2. csm_memory_search
3. csm_memory_list
4. csm_memory_delete
5. csm_memory_context
6. csm_memory_lesson
7. csm_memory_transcript
8. csm_memory_distill
9. csm_memory_distilled_view
10. csm_memory_compact
11. csm_memory_backfill_embeddings
12. csm_memory_dedup_detect
13. csm_memory_merge
14. csm_memory_candidate_generate
15. csm_memory_candidate_report
16. csm_memory_archive_candidate_report
17. csm_memory_governance_report
18. csm_runtime_status
19. csm_compaction_audit
20. csm_memory_packets
21. csm_belief_scan
22. csm_belief_scan_report
23. csm_belief_promote
24. csm_belief_promotion_scan
25. csm_self_model
26. csm_belief_knowledge
27. csm_living_state_preview
28. csm_living_state_debug
29. csm_recall_quality_report
30. csm_memory_related
31. csm_continuity_report

---

## 2. Actual ReEntryProtocol Interface

**File:** `src/re-entry-protocol.ts`

**Current method signature:**

```typescript
class ReEntryProtocol {
  constructor(pool: DatabasePool, config?: ReEntryConfig)

  // Main method - builds re-entry block
  async buildBlock(sessionId: string, projectId: string): Promise<string | null>

  // Main method - returns diagnostic information
  async diagnose(sessionId: string, projectId: string): Promise<ReEntryDiagnostic>

  // Configuration
  config: ReEntryConfig
}
```

**ReEntryDiagnostic interface:**

```typescript
interface ReEntryDiagnostic {
  enabled: boolean
  previewOnly: boolean
  maxChars: number
  totalChars: number
  trimLevel: 'none' | 'soft' | 'aggressive'
  layersBuilt: string[]  // Names of layers that were built
  layersDropped: LayerDropped[]
  layersTrimmed: LayerTrimmed[]
  sources: Record<string, string>  // Status of each source (ok/warning/error)
  budgetChars: number
}
```

**LayerDropped interface:**

```typescript
interface LayerDropped {
  layer: string  // Layer name
  reason: string  // Why it was dropped
}
```

**LayerTrimmed interface:**

```typescript
interface LayerTrimmed {
  layer: string  // Layer name
  originalSize: number  // Original size in characters
  newSize: number  // New size after trimming
  percentageReduction: number  // Reduction percentage
}
```

**LayerBuilt interface:**

```typescript
interface LayerBuilt {
  name: string  // Layer name
  text: string  // Layer content
}
```

---

## 3. Adapter Plan

**Problem:**
The Phase 8A spec expects a different interface structure than the real ReEntryProtocol provides.

**Solution:**
Create a small adapter layer that converts ReEntryProtocol's `ReEntryDiagnostic` output into the expected UX report format.

**Adapter implementation:**

```typescript
interface ReEntryPreviewReport {
  previewOnly: boolean
  wouldInject: boolean
  blockBuilt: boolean
  blockText: string | null
  layersIncluded: string[]
  layersTrimmed: string[]
  byteLength: number
  diagnostics: string[]
}

export class ReEntryPreviewAdapter {
  private reEntryProtocol: ReEntryProtocol

  constructor(reEntryProtocol: ReEntryProtocol) {
    this.reEntryProtocol = reEntryProtocol
  }

  async buildPreviewReport(
    sessionId: string,
    projectId: string
  ): Promise<ReEntryPreviewReport> {
    const diagnostic = await this.reEntryProtocol.diagnose(sessionId, projectId)
    const block = await this.reEntryProtocol.buildBlock(sessionId, projectId)

    const layersIncluded: string[] = diagnostic.layersBuilt
    const layersTrimmed = diagnostic.layersDropped.map(d => d.layer)
    const byteLength = block?.length ?? 0

    const diagnostics: string[] = []
    diagnostics.push(`Enabled: ${diagnostic.enabled}`)
    diagnostics.push(`Preview-only: ${diagnostic.previewOnly}`)
    diagnostics.push(`Max characters: ${diagnostic.maxChars}`)
    diagnostics.push(`Total characters: ${diagnostic.totalChars}`)
    diagnostics.push(`Trim level: ${diagnostic.trimLevel}`)

    if (diagnostic.layersDropped.length > 0) {
      diagnostics.push('Layers dropped:')
      for (const dropped of diagnostic.layersDropped) {
        diagnostics.push(`  - ${dropped.layer}: ${dropped.reason}`)
      }
    }

    if (diagnostic.layersTrimmed.length > 0) {
      diagnostics.push('Layers trimmed:')
      for (const trimmed of diagnostic.layersTrimmed) {
        diagnostics.push(
          `  - ${trimmed.layer}: ${trimmed.originalSize} → ${trimmed.newSize} chars (${trimmed.percentageReduction.toFixed(1)}%)`
        )
      }
    }

    return {
      previewOnly: diagnostic.previewOnly,
      wouldInject: diagnostic.enabled && block !== null,
      blockBuilt: block !== null,
      blockText: block ?? null,
      layersIncluded,
      layersTrimmed,
      byteLength,
      diagnostics,
    }
  }
}
```

**Tool implementation:**

```typescript
export function reentryPreviewTool(adapter: ReEntryPreviewAdapter) {
  return {
    description: 'Get the current re-entry block for a session/project without injecting it into the system prompt. Shows layers, trimming diagnostics, and token estimate. Does not modify any state.',
    args: {},
    async execute(_args, context) {
      const sessionId = context.sessionID || 'unknown'
      const projectId = context.directory || 'default'

      const report = await adapter.buildPreviewReport(sessionId, projectId)

      return {
        title: 'Re-entry Preview',
        output: this.formatReport(report),
        metadata: {
          previewOnly: report.previewOnly,
          wouldInject: report.wouldInject,
          blockBuilt: report.blockBuilt,
          byteLength: report.byteLength,
          layersIncluded: report.layersIncluded,
          layersTrimmed: report.layersTrimmed,
        },
      }
    },

    formatReport(report: ReEntryPreviewReport): string {
      const lines: string[] = []

      lines.push('## Re-entry Preview')
      lines.push(`Session: ${context.sessionID || 'unknown'}`)
      lines.push(`Project: ${context.directory || 'default'}`)
      lines.push('')

      lines.push('### Status')
      lines.push(`- Enabled: ${report.previewOnly ? 'yes' : 'no'}`)
      lines.push(`- Would inject: ${report.wouldInject ? 'yes' : 'no'}`)
      lines.push(`- Block built: ${report.blockBuilt ? 'yes' : 'no'}`)
      lines.push(`- Byte length: ${report.byteLength}`)
      lines.push('')

      if (report.blockText) {
        lines.push('### Block Content')
        lines.push(report.blockText)
        lines.push('')
      } else if (report.previewOnly) {
        lines.push('### Block Content')
        lines.push('(No block - preview-only mode or no content)')
        lines.push('')
      }

      lines.push('### Layers')
      lines.push(`- Included: ${report.layersIncluded.join(', ') || 'none'}`)
      lines.push(`- Trimmed: ${report.layersTrimmed.join(', ') || 'none'}`)
      lines.push('')

      lines.push('### Diagnostics')
      for (const line of report.diagnostics) {
        lines.push(line)
      }
      lines.push('')

      return lines.join('\n')
    },
  }
}
```

---

## 4. Validation Checklist

- [x] Full tests return to 808/808
- [x] Tool registry consistent (31 tools, no unimplemented tools)
- [x] Typecheck clean
- [x] Build clean
- [x] Lint remains 7 (opentui.d.ts only)
- [ ] ReEntryPreviewAdapter implemented (next step)
- [ ] csm_reentry_preview tool registered (next step)
- [ ] Phase 8A-Impl tests written (next step)

---

## 5. Correct Phase Order

1. **Phase 8A-R**: Restore 808/808 and document real interface ✅ (DONE)
2. **Phase 8A-Impl**: Implement csm_reentry_preview using adapter (NEXT)
3. **Phase 8B**: Live enablement controls
4. **Phase 8C**: Smart trimming

---

## 6. Known Gaps

The current ReEntryProtocol interface does not include:
- Token count estimation (uses character count instead)
- Detailed layer content extraction (only has layer names)
- Formatted diagnostics (needs adapter)

These gaps are acceptable because:
- The adapter layer can estimate tokens
- The adapter layer can extract layer content if needed
- The adapter layer can format diagnostics

---

**Last Updated:** 2026-07-08
**Phase:** 8A-R Repair
**Status:** Complete (docs), Pending (implementation)

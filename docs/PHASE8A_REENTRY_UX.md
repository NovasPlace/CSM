## Phase 8A — Re-entry UX / Control Surface

**File:** `src/reentry-ux-tool.ts`

**Goal:**
Make the re-entry protocol visible, inspectable, and controllable with live first-turn injection as the default.

---

## 1. Targets

### Target 1: Add a read-only tool
**Tool:** `csm_reentry_preview`

**Responsibilities:**
- Build the re-entry block for a given session/project
- Show layers, trimming, token estimate, preview-only status
- Does NOT inject into system prompt
- Does NOT write to memory/belief/work-journal
- Does NOT modify any CSM state

**Parameters:**
```typescript
interface ReentryPreviewInput {
  sessionId?: string;
  projectId?: string;
  layers?: string[]; // Optional layer filter
  showDiags?: boolean; // Show detailed diagnostics
}
```

**Output:**
```typescript
interface ReentryPreviewOutput {
  sessionId: string;
  projectId: string;
  enabled: boolean;
  previewOnly: boolean;
  maxChars: number;
  block: string | null; // The assembled block or null
  assembledLayers: Record<string, string>; // Layer content
  diagnostics: ReEntryDiagnostic; // Trimming, budget, etc.
  tokenEstimate: number;
  injectionStatus: 'built' | 'preview-only' | 'disabled';
}
```

**Tool name:** `csm_reentry_preview`

---

### Target 2: Add a status/report section

**Integration:** Add to the context brief or living state advisory block

**Sections:**
1. **Re-entry enabled**: true/false flag
2. **Preview-only mode**: true/false flag
3. **Last build result**: success/failure status
4. **Trimmed layers**: list of layers that were trimmed due to budget
5. **First-turn injection status**: session ID in `reentryInjected` Set

**Example output:**
```
## Re-entry Status
- Enabled: true
- Preview-only: true
- Last build: success (2026-07-08 18:00:00)
- Trimmed layers: []
- First-turn injection: false
- Token estimate: 842 tokens
```

---

### Target 3: Add config controls

**Environment Variables:**
```bash
CSM_REENTRY_ENABLED=true          # Enable/disable re-entry
CSM_REENTRY_PREVIEW_ONLY=false    # Default live first-turn injection
CSM_REENTRY_MAX_CHARS=2100        # Max block size for budgeting
CSM_REENTRY_MIN_LAYER_CHARS=50    # Min characters per layer
```

**Runtime Configuration:**
```typescript
interface ReEntryConfig {
  enabled: boolean;       # Enable/disable re-entry
  maxChars: number;       # Max block size
  previewOnly: boolean;   # Preview-only mode (default: false)
  minLayerChars: number;  # Min chars per layer
  layers: string[];       # Layer order
}
```

**Controls:**
- **Preview-only toggle**: Changes `previewOnly` flag in config
- **Budget slider**: Adjusts `maxChars` parameter
- **Layer visibility**: Shows which layers are included/excluded
- **Injection toggle**: Enables/disables block injection (NOT for Phase 8A)

**Hard Constraints:**
- **Live default**: `CSM_REENTRY_PREVIEW_ONLY=false` by default
- **No synthetic first-turn injection**: Block only in system prompt
- **No mutation**: Read-only tool, no writes to CSM tables
- **No memory writes during preview**: `csm_reentry_preview` performs no writes
- **No dual-mode switching yet**: Only preview mode in Phase 8A

---

### Target 4: Tests

**Test file:** `test/phase-8a-reentry-ux-tool.test.ts`

**Test cases:**
1. **Preview tool performs no writes**
   - Verify `csm_reentry_preview` doesn't modify memories
   - Verify no SQL INSERT/UPDATE/DELETE on any CSM table
   - Verify no calls to `memoryManager.saveMemory()`, `beliefStore.add()`, etc.

2. **Disabled mode reports correctly**
   - Set `CSM_REENTRY_ENABLED=false`
   - Verify output shows `enabled: false`
   - Verify `block` is null
   - Verify diagnostics show disabled status

3. **Enabled config reports correctly**
   - Set `CSM_REENTRY_ENABLED=true`, `CSM_REENTRY_PREVIEW_ONLY=true`
   - Verify output shows correct flags
   - Verify `block` is null (preview-only)
   - Verify diagnostics show preview-only status

4. **Trimming diagnostics display correctly**
   - Set `CSM_REENTRY_MAX_CHARS=100` (very low budget)
   - Verify diagnostics show trimmed layers
   - Verify `tokenEstimate` reflects actual block size
   - Verify `trimLevel` shows 'aggressive' or 'soft'

5. **Missing state degrades gracefully**
   - Request preview for non-existent session
   - Verify output doesn't throw error
   - Verify `block` is null
   - Verify diagnostics show `trimLevel: 'none'`
   - Verify all required fields present

6. **Layer filter works correctly**
   - Request preview with specific layer filter
   - Verify output only shows requested layers
   - Verify diagnostic shows which layers were filtered

---

## 2. Integration Points

### PluginContext Tools

Add to `src/hooks-registration.ts`:

```typescript
// In pluginCtx.reentryTools
reentryTools: {
  preview: async (input: ReentryPreviewInput): Promise<ReentryPreviewOutput> => {
    // Calls ReEntryProtocol.diagnostics() + buildBlock()
  }
}
```

### Context Brief Section

Add to `src/hooks/system-transform.ts`:

```typescript
// After context brief, before living state advisory
if (ctx.reentryTools?.preview) {
  const status = await ctx.reentryTools.preview({
    projectId: ctx.config.project,
    sessionId: sessionID,
    showDiags: true,
  });

  if (status.block === null && status.enabled) {
    output.system.push(`## Re-entry Status\n${formatStatus(status)}\n`);
  }
}
```

---

## 3. Helper Functions

**`formatStatus(status: ReentryPreviewOutput): string`**

```typescript
function formatStatus(status: ReentryPreviewOutput): string {
  const lines = [
    `Enabled: ${status.enabled}`,
    `Preview-only: ${status.previewOnly}`,
    `Last build: ${status.injectionStatus}`,
    `Token estimate: ${status.tokenEstimate}`,
  ];

  if (status.trimmedLayers.length > 0) {
    lines.push(`Trimmed layers: ${status.trimmedLayers.join(', ')}`);
  }

  if (status.diagnostics.budgetChars !== status.diagnostics.totalChars) {
    lines.push(`Trim level: ${status.diagnostics.trimLevel}`);
  }

  return lines.join('\n');
}
```

---

## 4. Acceptance Criteria

**Phase 8A Acceptance Checklist:**

- [ ] `csm_reentry_preview` tool created (`src/reentry-ux-tool.ts`)
- [ ] Read-only tool performs no writes
- [ ] Disabled mode reports correctly
- [ ] Enabled config reports correctly
- [ ] Trimming diagnostics display correctly
- [ ] Missing state degrades gracefully
- [ ] Layer filter works correctly
- [ ] Status section added to context brief
- [ ] Configuration controls implemented
- [ ] All tests pass (targeted + full suite)
- [ ] Typecheck clean
- [ ] Build clean
- [ ] Lint remains 7 (opentui.d.ts only)

**Manual Validation Steps:**

1. **Live injection mode (default):**
   ```bash
   npm run dev
   # Agent starts with a re-entry block in the system prompt
   # Verify logs show: "Re-entry block injected"
   ```

2. **Disabled mode:**
   ```bash
   export CSM_REENTRY_ENABLED=false
   npm run dev
   # Agent starts, no re-entry block
   # Verify logs show: "Re-entry disabled"
   ```

3. **Inspect block via tool:**
   ```bash
   # Agent running
   csm_reentry_preview --sessionId=xxx --projectId=yyy
   # Verify output shows block content (null if preview-only)
   ```

---

## 5. Known Limitations

1. **No live preview toggle**: Preview-only mode requires restart to change
2. **No budget adjustment UI**: Requires environment variable changes
3. **No layer visibility toggle**: Requires code changes
4. **No synthetic message injection**: Only system prompt augmentation
5. **No dual-mode switching**: Only preview mode in Phase 8A

---

## 6. Future Work (Phase 8B+)

- **Phase 8B: Live Enablement**: Runtime toggle for preview-only vs injection
- **Phase 8C: Smart Trimming — implemented**: Prior-session turn count selects
  a deterministic 60%, 80%, or 100% character ceiling; the selected tier is
  visible in diagnostics and persisted injection provenance
- **Phase 8D: Layer Visibility**: User toggle for layer inclusion/exclusion
- **Phase 8E: Budget Slider**: Interactive token budget adjustment
- **Phase 8F: Block Visualization**: Visual representation of block structure

---

## 7. References

- Phase 7A: Re-entry Context Builder (`src/re-entry-protocol.ts`)
- Phase 7B: Session Start Integration (`src/hooks/system-transform.ts`)
- Phase 7C: Documentation (`docs/PHASE7C_REENTRY_PROTOCOL_DOCUMENTATION.md`)
- Phase 8A: This specification
- Test file: `test/phase-8a-reentry-ux-tool.test.ts` (to be created)

---

**Last Updated:** 2026-07-08
**Phase:** 8A UX / Control Surface
**Status:** Ready for implementation

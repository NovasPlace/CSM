## Phase 7C — Re-entry Protocol Documentation

### Goal
Document Phase 7A/7B so future agents understand how onboarding/re-entry works and how to safely enable it.

---

## 1. Purpose

**Rehydration of fresh model/session into current CSM-backed agent context.**

When a new session starts (first message after idle timeout), the agent needs contextual grounding from CSM memories. Re-entry protocol provides this by:

1. **Detecting first-turn**: Identifies fresh sessions via `ctx.state.reentryInjected: Set<string>`
2. **Building contextual block**: Assembles identity, goals, work, preferences, capabilities, beliefs, context, constraints
3. **Diagnostics logging**: Tracks assembly, trimming, injection status
4. **Live injection mode**: Default first-turn behavior
5. **Preview-only mode**: Configurable via `CSM_REENTRY_PREVIEW_ONLY=true`

---

## 2. Injection Mode

**System prompt augmentation only.**

- No synthetic first-turn message injected into conversation
- No user instruction sent to opencode core
- No dual-mode switching yet
- Block appended to `output.system` array in system-transform.ts

```typescript
// system-transform.ts:290-312
if (block && ctx.state.reentryInjected.has(sessionID) === false) {
  output.system.push(`## Agent Re-entry Context\n${block}\n`);
  ctx.state.reentryInjected.add(sessionID);
  ctx.logger?.info('Re-entry block injected', { sessionID });
}
```

---

## 3. Live Injection Default

**`CSM_REENTRY_PREVIEW_ONLY=false` (default)**

- Block built and diagnostics logged
- Default behavior: inject once on first turn
- Block is NOT injected only when preview-only mode is explicitly enabled
- User controls injection via environment variable or runtime config

```bash
# Default: live first-turn injection; env var may be omitted
export CSM_REENTRY_PREVIEW_ONLY=false

# Explicit preview-only test mode
export CSM_REENTRY_PREVIEW_ONLY=true
```

**Injection control flow:**

```
diagnose() → buildBlock() → previewOnly?
                              ├─ true: log "built, not injected"
                              └─ false: inject to output.system
```

---

## 4. Layer Order

**Identity → Active Goals → In-Progress Work → Preferences → Capabilities → Beliefs → Recent Context → Constraints**

Each layer is assembled by `ReEntryProtocol.diagnostics()`:

```typescript
interface LayerAssembly {
  identity: { count: number; text: string };
  activeGoals: { count: number; text: string };
  inProgressWork: { count: number; text: string };
  preferences: { count: number; text: string };
  capabilities: { count: number; text: string };
  beliefs: { count: number; text: string };
  recentContext: { count: number; text: string };
  constraints: { count: number; text: string };
}
```

**Budget trimming applies from lower priority upward:**
- Work → Preferences → Capabilities → Beliefs → Context

---

## 5. Trimming Behavior

**Identity and Constraints are NEVER trimmed** (hard constraints for system prompt integrity).

**Trimming order (by budget algorithm):**
1. Active Goals
2. In-Progress Work
3. Preferences
4. Capabilities
5. Beliefs
6. Recent Context

**Trimmed layers logged:**

```typescript
interface TrimmingReport {
  originalSize: number;
  newSize: number;
  percentageReduction: number;
}
```

---

## 6. Safety Model

**Operational context, not user instruction.**

- Block is added to system prompt, not sent as user message
- Block uses third-person perspective: "The agent has X goals" not "You have X goals"
- No memory/belief/work-journal mutation during transform
- No hooks that write to CSM tables (read-only)
- Diagnostic logging only, no side effects

**Safety guarantees:**
- ✅ No conversation message injection
- ✅ No instruction override
- ✅ No user prompt tampering
- ✅ No memory writeback
- ✅ Read-only assembly process

---

## 7. Diagnostics

**Logged for each re-entry build:**

1. **Built status**: `Re-entry block built` or `Re-entry block injected`
2. **Preview-only status**: Whether `previewOnly` flag was set
3. **Layers assembled**: Count and text for each layer
4. **Layers trimmed**: Which layers dropped and why (token budget)
5. **First-turn tracking**: Session ID in `ctx.state.reentryInjected` Set

**Example log:**

```
[INFO] Re-entry block diagnosed
  - Layers assembled: identity:3, goals:2, work:1, preferences:4, capabilities:3, beliefs:5, context:3, constraints:2
  - Layers trimmed: []
  - Preview-only: true
  - Total layers: 23

[INFO] Re-entry block injected
  - Session: sess-123
  - Layers used: identity(3), goals(2), work(1), preferences(4), capabilities(3), beliefs(5), context(3), constraints(2)
```

---

## 8. Validation Checklist

### Phase 7C Acceptance

- [x] `docs/PHASE7_REENTRY_PROTOCOL.md` updated
- [ ] Full test suite passes (804+ tests)
- [ ] Typecheck clean
- [ ] Build clean
- [ ] Lint remains 7 (opentui.d.ts only)
- [ ] Live restart confirms first-turn injection occurs by default
- [ ] Enabled injection test passes

### Manual Validation Steps

1. **Preview-only mode**:
   ```bash
   export CSM_REENTRY_PREVIEW_ONLY=true
   npm run dev
   # Fresh session → block built, NOT injected
   # Check logs for "Re-entry block built"
   # Check system prompt → no re-entry block
   ```

2. **Injection enabled**:
   ```bash
   export CSM_REENTRY_PREVIEW_ONLY=false
   npm run dev
   # Fresh session → block injected
   # Check logs for "Re-entry block injected"
   # Check system prompt → re-entry block present
   ```

3. **Consecutive turns**:
   ```bash
   # First turn: block injected
   # Second turn: block NOT injected (reentryInjected tracking)
   # Check logs: "Re-entry block diagnosed" but no "injected"
   ```

---

## 9. Configuration

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CSM_REENTRY_PREVIEW_ONLY` | `false` | Preview-only mode is opt-in for testing |
| `CSM_REENTRY_MAX_TOKENS` | `1000` | Max block size for budget trimming |
| `CSM_REENTRY_ENABLED` | `true` | Enable/disable re-entry entirely |

### Runtime Configuration

```typescript
// PluginContext.reEntryProtocol (optional)
const reEntryProtocol = {
  diagnose: async (sessionID: string) => {
    // Returns LayerAssembly, TrimmingReport, previewOnly, totalLayers
  },
  buildBlock: async (sessionID: string) => {
    // Returns contextual block string or null
  }
}
```

---

## 10. Integration Points

### system-transform.ts (lines 289-312)

**Re-entry block injection:**

```typescript
const block = await reEntryProtocol.buildBlock(sessionID);
if (block && ctx.state.reentryInjected.has(sessionID) === false) {
  output.system.push(`## Agent Re-entry Context\n${block}\n`);
  ctx.state.reentryInjected.add(sessionID);
  ctx.logger?.info('Re-entry block injected', { sessionID });
} else if (block) {
  ctx.logger?.info('Re-entry block built', { sessionID, previewOnly: true });
}
```

### hooks-registration.ts (lines 433-441)

**ReEntryProtocol instantiation:**

```typescript
const reEntryProtocol: ReEntryProtocol = {
  diagnose: async (sessionID: string) => {
    // Assembly, trimming, previewOnly determination
  },
  buildBlock: async (sessionID: string) => {
    // Build contextual block from assembled layers
  }
};
```

### PluginState (sessionState initialization)

```typescript
state: {
  currentSessionId: null,
  messageCount: 0,
  capturedMessageSizes: new Map(),
  recentUserMessages: new Map(),
  reentryInjected: new Set<string>() // First-turn tracking
}
```

---

## 11. Known Limitations

1. **No runtime dual-mode switching yet**: Changing preview/live mode still requires restart
2. **No first-turn synthetic message**: Block only in system prompt, not conversation
3. **No user instruction**: Block is third-person, not "You have..."
4. **No experimental features**: No adaptive token budgeting, no learning

---

## 12. Future Work (Phase 8+)

- **User experience pattern**: UI/CLI control for preview-only vs injection
- **Deliverability**: Inject block as synthetic message on first turn
- **Smart trimming**: Adaptive token budgeting based on session length
- **Multi-session context**: Support for parallel sessions with re-entry
- **Belief-driven selection**: Prioritize layers based on belief confidence

---

## 13. References

- Phase 7A: Re-entry Protocol design (`docs/PHASE7A_REENTRY_PROTOCOL_DESIGN.md`)
- Phase 7B: System transform integration (`src/hooks/system-transform.ts:289-312`)
- Phase 7C: This documentation
- Test coverage: `test/phase-7b-system-transform.test.ts` (4 tests)
- Re-entry protocol: `src/hooks/reentry-protocol.ts` (18 functions)

---

**Last Updated:** 2026-07-08
**Phase:** 7C Documentation
**Status:** Ready for full validation

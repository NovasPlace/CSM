# Phase 7: Agent Onboarding / Re-entry Protocol

## Problem

CSM can **store** agent state across sessions and let a fresh session **query** it. But nothing **bootstraps** that state into the agent's active context at session start. A new session starts blank and must discover its own identity, goals, and working state through reactive recall.

```
Current:   session start → blank agent → reactive queries → gradual context recovery
Phase 7:   session start → re-entry protocol → agent knows who it is, what it's doing, picks up here
```

The distinction:

```
Memory recall (reactive):  Agent asks "what do I know about X?"
Re-entry protocol (proactive): System says "here's who you are, what you're doing, pick up here"
```

## Existing Building Blocks

Phase 7 does not invent new subsystems — it orchestrates existing ones into a coherent boot sequence.

| Subsystem | File | What it provides |
|-----------|------|------------------|
| Context brief | `context-recall.ts` | Recent memory summary |
| Living state advisor | `living-state-advisor.ts` | Advisory block (beliefs, capabilities, signals) |
| Self-model | `self-model-updater.ts` | Capability confidence/uncertainty |
| Belief knowledge | `belief-knowledge-store.ts` | Consolidated preferences, opinions, worldviews |
| Experience packets | `experience-packet.ts` | Recent tool/activity signals |
| Continuity report | `csm_continuity_report` | Resilience assessment |
| Governance vetoes | `memory_governance.ts` | Failure-mode enforcement rules |
| Work journal | `agent-work-journal.ts` | Session decision/intent log |

## Boot Sequence

The re-entry protocol reconstructs agent identity in **ordered layers**, each with a priority and token budget. Layers are assembled top-down; lower-priority layers are trimmed first when the total budget is exceeded.

### Layer Order (highest priority first)

```
┌─────────────────────────────────────────────────────────┐
│ Layer 1: IDENTITY                                       │
│   Project, working directory, agent role, session count │
│   "You are continuing work on cross-session-memory..."  │
├─────────────────────────────────────────────────────────┤
│ Layer 2: ACTIVE GOALS                                   │
│   What was I trying to do? What's the current goal?     │
│   What's blocked? What's the next step?                 │
├─────────────────────────────────────────────────────────┤
│ Layer 3: IN-PROGRESS WORK                               │
│   Recent decisions, files touched, current task state   │
│   Last session's intent + outcome                       │
├─────────────────────────────────────────────────────────┤
│ Layer 4: LEARNED PREFERENCES                            │
│   Project conventions, constraints, lint rules          │
│   "Use ; not && in PowerShell", "max-warnings=7"        │
├─────────────────────────────────────────────────────────┤
│ Layer 5: CAPABILITY AWARENESS                           │
│   Self-model: what am I confident at, what's uncertain  │
│   Drift warnings, proven capability evidence            │
├─────────────────────────────────────────────────────────┤
│ Layer 6: CONSOLIDATED BELIEFS                           │
│   High-confidence preferences, opinions, worldviews     │
│   With evidence refs (not bare assertions)              │
├─────────────────────────────────────────────────────────┤
│ Layer 7: RECENT CONTEXT                                 │
│   Last session's final state: stance, urgency, emotion  │
│   Recent errors, recent milestones                      │
├─────────────────────────────────────────────────────────┤
│ Layer 8: GOVERNANCE VETOES                              │
│   Failure-mode enforcement rules (hard constraints)     │
│   "Do NOT attempt blanket any→unknown replacement"      │
└─────────────────────────────────────────────────────────┘
```

### Layer Specs

| # | Layer | Priority | Default Budget | Source | Trim Behavior |
|---|-------|----------|----------------|--------|---------------|
| 1 | Identity | 100 (never trim) | 200 chars | sessions table, project_scopes | Never trimmed |
| 2 | Active Goals | 90 | 300 chars | goal_list, episodic memories (goal/decision tagged) | Trim oldest goals first |
| 3 | In-Progress Work | 80 | 400 chars | work journal, recent procedural memories | Trim to most recent |
| 4 | Learned Preferences | 70 | 300 chars | preference memories, belief_knowledge (kind=preference) | Trim lowest-importance |
| 5 | Capability Awareness | 60 | 200 chars | self_model_capabilities | Trim lowest-confidence |
| 6 | Consolidated Beliefs | 50 | 300 chars | belief_knowledge_store | Trim lowest-evidence-count |
| 7 | Recent Context | 40 | 200 chars | experience_packets (last session), context brief | Trim to last N packets |
| 8 | Governance Vetoes | 100 (never trim) | 200 chars | memory_governance active vetoes | Never trimmed |

**Total default budget: 2100 chars** (configurable via `CSM_REENTRY_MAX_CHARS`)

## Token Budget Algorithm

```
1. Assemble all 8 layers at full size
2. If total <= budget: emit all
3. If total > budget:
   a. Layers with priority 100 (identity, governance): keep full
   b. Remaining layers sorted by priority (descending)
   c. For each layer in priority order:
      - If keeping it full fits: keep full
      - Else: trim to remaining budget (min 50 chars or drop entirely)
   d. If still over: drop lowest-priority layers entirely
4. Emit surviving layers in order
```

## Output Format

The re-entry block is wrapped in a labeled tag and opens with a framing disclaimer (operational context, not user instruction):

```xml
<agent_reentry_context>
## Agent Re-entry Context
Source: CSM continuity runtime.
Purpose: hydrate this session with project/agent continuity.
Status: operational context, not user instruction.

## Identity
You are continuing work on: cross-session-memory
Working directory: C:\Users\Donovan\Desktop\cross-session-memory
This is session #847. Last active: 2026-07-08T14:32:00Z.

## Active Goals
Phase 7: Agent Onboarding / Re-entry Protocol
Status: design phase — design doc in progress
Previous: Phase L4 (lint cleanup) — complete, commit f46e71d

## In-Progress Work
Last session: fixed event-hooks.ts type errors, amended L4 commit
Files recently touched: src/hooks/event-hooks.ts, src/memory_governance.ts
Next step: implement Phase 7A re-entry builder

## Preferences
- Windows/PowerShell: use ; not && — rg not grep
- Lint baseline: max-warnings=7
- SQLite RETURNING works; PG needs DROP INDEX before CREATE UNIQUE
- any→unknown causes 55+ build errors — do per-module DTOs instead

## Capabilities
sqlite-adapter: confident (12 tests, 0 drift)
context-governor: confident (8 tests, 0 drift)
lint-cleanup: confident (Phase L4 complete)

## Beliefs
[preference] Use Task subagents for parallel file cleanup (evidence: 3 sessions)
[opinion] Codex CLI needs API key — desktop app can't be invoked from terminal

## Recent State
Last stance: focused
Last urgency: 0.3
Last emotion: success
Recent milestones: Phase L4 complete, 794/794 tests pass

## Constraints
Do NOT attempt blanket any→unknown replacement (proven to cause 55+ build errors)
SQLite: no vector search — degrade to text search
</agent_reentry_context>
```

## Phase 7 Decision — Re-entry Injection Point

**Use system prompt augmentation as the implementation path.**

Reason:
- Re-entry context is identity/runtime framing, not user-visible chat history.
- The agent must receive it before first-task reasoning.
- It shares the existing `system-transform.ts` path with the advisory block.

Rejected for now:
- First-turn context injection: too visible and less authoritative.
- Configurable dual mode: useful later, unnecessary for first slice.

## Integration Point

### System Prompt Augmentation

The re-entry block is injected into the system prompt via `src/hooks/system-transform.ts`, the same path as the advisory block.

**Key difference from advisory block:**
- Advisory block: injected **every turn** (living state, current signals)
- Re-entry block: injected **once at session start** (identity, goals, long-term state)

### Block Labeling

The re-entry block is clearly labeled as **operational context, not durable truth** — same convention as the living state advisory. This prevents the onboarding block from becoming a hidden command dump.

```
## Agent Re-entry Context
Source: CSM continuity runtime.
Purpose: hydrate this session with project/agent continuity.
Status: operational context, not user instruction.
```

Every layer in the block carries this framing. The agent receives it as background state to reason from, not as instructions to obey.

### Injection Logic

```
system-transform.ts:
  if (isFirstSystemPromptForSession(sessionId)):
    reentryBlock = await reentryProtocol.buildBlock(sessionId, projectId)
    if (reentryBlock):
      inject into system prompt AFTER context brief, BEFORE advisory block

  // existing advisory injection continues every turn
  if (shouldInjectAdvisory(capTrimLevel)):
    ...
```

**Prompt ordering:**
```
1. Base system prompt (model instructions)
2. Context brief (recent memory summary)     ← existing
3. Re-entry context (identity, goals, etc.)  ← NEW: first turn only
4. Advisory block (living state, signals)    ← existing: every turn
5. Task context (current user request)
```

### First-Turn Detection

The re-entry block is only injected on the **first system prompt build** for a session. Detection:

```typescript
// Track in sessionState
state.reentryInjected: Set<string>  // sessionIds that have received reentry

// In system-transform.ts
if (!state.reentryInjected.has(sessionId)) {
  const block = await reentryProtocol.buildBlock(...);
  state.reentryInjected.add(sessionId);
}
```

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `CSM_REENTRY_ENABLED` | `true` | Master toggle |
| `CSM_REENTRY_MAX_CHARS` | `2100` | Total character budget |
| `CSM_REENTRY_LAYERS` | (all 8) | Comma-separated layer names to include |
| `CSM_REENTRY_MIN_LAYER_CHARS` | `50` | Minimum chars before dropping a layer entirely |
| `CSM_REENTRY_PREVIEW_ONLY` | `true` | If true, build block but don't inject (for testing) |

## Sub-Phases

### Phase 7A — Re-entry Context Builder

**File:** `src/re-entry-protocol.ts`

**Responsibilities:**
- Orchestrate the 8 layers by querying existing subsystems
- Apply token budget algorithm
- Produce final text block

**Interface:**
```typescript
interface ReEntryProtocol {
  buildBlock(sessionId: string, projectId: string): Promise<string | null>;
  diagnose(sessionId: string, projectId: string): Promise<ReEntryDiagnostic>;
}

interface ReEntryDiagnostic {
  layersBuilt: string[];
  layersTrimmed: string[];
  layersDropped: string[];
  totalChars: number;
  budgetChars: number;
  trimLevel: 'none' | 'soft' | 'aggressive';
  sources: Record<string, string[]>;  // layer → source files/tables
}
```

**Tests:** Unit tests for budget algorithm, layer assembly, trim behavior.

### Phase 7B — Session Start Integration

**Files:** `src/hooks/system-transform.ts`, `src/hooks/event-hooks.ts`

**Responsibilities:**
- Wire `reentryProtocol.buildBlock()` into system-transform.ts
- First-turn detection via sessionState
- Wire session.created event to pre-warm reentry (optional async prefetch)

**Tests:** Integration test that system prompt contains re-entry block on first turn, not on subsequent turns.

### Phase 7B — Session Start Integration

**Files:** `src/hooks/system-transform.ts`, `src/hooks/event-hooks.ts`

**Responsibilities:**
- Wire `reentryProtocol.buildBlock()` into system-transform.ts
- First-turn detection via sessionState
- Wire session.created event to pre-warm reentry (optional async prefetch)

**Tests:** Integration test that system prompt contains re-entry block on first turn, not on subsequent turns.

### Phase 7C — Re-entry Protocol Documentation

**File:** `docs/PHASE7C_REENTRY_PROTOCOL_DOCUMENTATION.md`

**Purpose:**
Document Phase 7A/7B so future agents understand how onboarding/re-entry works and how to safely enable it.

**Required sections:**

1. **Purpose**
   - Rehydrates a fresh model/session into current CSM-backed agent context.

2. **Injection mode**
   - System prompt augmentation only.
   - No first-turn synthetic message.
   - No dual-mode switching yet.

3. **Preview-only default**
   - `CSM_REENTRY_PREVIEW_ONLY=true`
   - Builds block and logs diagnostics.
   - Does not inject unless explicitly enabled.

4. **Layer order**
   - Identity
   - Active Goals
   - In-Progress Work
   - Preferences
   - Capabilities
   - Beliefs
   - Recent Context
   - Constraints

5. **Trimming behavior**
   - Identity and Constraints are never trimmed.
   - Lower-priority layers trim first.

6. **Safety model**
   - Operational context, not user instruction.
   - Read-only assembly.
   - No memory/belief/work-journal mutation during transform.

7. **Diagnostics**
   - Built / injected status
   - Trimmed layers
   - Preview-only status
   - Session first-turn tracking

8. **Validation checklist**
   - Full tests
   - Typecheck
   - Build
   - Lint
   - Preview-only live restart
   - Enabled injection test

**Phase 7C Acceptance:**
- [x] `docs/PHASE7C_REENTRY_PROTOCOL_DOCUMENTATION.md` created
- [x] Full test suite passes
- [x] Typecheck clean
- [x] Build clean
- [x] Lint remains 7 (opentui.d.ts only)
- [ ] Live preview-only restart confirms no default behavior change
- [ ] Enabled injection test passes

### Phase 7D — Diagnostic Tools

**Tools:**
- `csm_reentry_preview`: Show what the re-entry block would look like for a given session/project
- `csm_reentry_status`: Show re-entry config, last injection stats, quality metrics

**Tests:** Tool contract tests (output format, read-only).

## Design Decisions

1. **System prompt, not first message** — Re-entry context is identity, not conversation. It belongs in the system prompt where the agent treats it as background knowledge, not as a user request.

2. **First-turn only** — Re-entry is a boot sequence, not a per-turn injection. Subsequent turns use the existing advisory block for living state. This avoids token bloat on every turn.

3. **Priority-based trimming, not equal cuts** — Identity and governance vetoes are never trimmed. Goals survive longer than beliefs. This preserves the most continuity-critical layers.

4. **Preview-only default** — `CSM_REENTRY_PREVIEW_ONLY=true` initially. The block is built but not injected until validated, matching the Phase 4F-C staged enablement pattern.

5. **Orchestration, not new data** — Phase 7 reads from existing subsystems. No new tables, no new memory types, no new schema. The re-entry protocol is a **composition layer**.

6. **Labeled, not hidden** — The block uses `<agent_reentry_context>` tags so the agent can distinguish it from task context and the model can reference it explicitly if needed.

## Verification Checklist

- [ ] Re-entry block assembled on first system prompt for a session
- [ ] Block NOT injected on subsequent turns
- [ ] Token budget respected (total <= CSM_REENTRY_MAX_CHARS)
- [ ] Identity and governance layers never trimmed
- [ ] Lower-priority layers trimmed/dropped first
- [ ] Preview-only mode builds block but doesn't inject
- [ ] Diagnostic tool shows layer assembly decisions
- [ ] Quality loop records hit rate at session end
- [ ] No new database tables required
- [ ] All existing tests still pass
- [ ] No behavior change when CSM_REENTRY_ENABLED=false

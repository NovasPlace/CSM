# Phase 9A-Tune: Onboarding Handoff Continuity — Task List

## Goal
A fresh agent session should wake up knowing what the prior agent was doing, what was said, and where to continue — without cold-reading the repo.

## Current State
- Onboarding packet injects FIRST in system-transform (working)
- 10 sections: identity, project, phase, constraints, memories, beliefs, advisories, tools, handoff, readiness
- AGENTS.md updated with Phase 9A progress
- `.env` loader added to config.ts
- Re-entry live injection is the default (`CSM_REENTRY_PREVIEW_ONLY=false`)
- 903/903 tests pass, build clean

## What Works
- [x] Onboarding packet injects on first turn
- [x] Identity brief (Prime Directive, instincts, wake signal)
- [x] Phase-checkpoint reads AGENTS.md (updated to Phase 9A)
- [x] Constraints (hardwired instincts + key decisions)
- [x] Handoff finds latest session for workfolder
- [x] Work journal entries show tool calls, files touched
- [x] Open threads from episodic memories
- [x] Checkpoints from .csm/
- [x] Readiness summary ("You are awake as a continuation... Resume, do not restart.")

## What Doesn't Work Yet

### Task 1: Transcript turns only show assistant, not user
- **Problem**: The handoff queries `memories` table for `memory_type='conversation'`. The prior session only has assistant-role conversation memories saved when the new session starts. User messages arrive later via async hooks.
- **Investigation done**: `chat_messages` table exists with `role`, `content`, `thread_id`, `created_at` columns. No `session_id` column — uses `thread_id` instead. Need to map `session_id` → `thread_id`.
- **Fix**: Query `chat_messages` table to get the actual last N turns (user + assistant) from the prior session. The `thread_id` likely maps to the session or a thread within it.
- **Files**: `src/agent-onboarding.ts` (handoff provider, ~line 670)

### Task 2: Session matching picks the new session, not the prior one
- **Problem**: The handoff finds the most recent session excluding the current one (`id <> ctx.sessionId`). But `ctx.sessionId` is often `'default'` or the OpenCode session ID. The NEW session (just started, 0 turns) is sometimes picked instead of the PRIOR session.
- **Fix**: Skip sessions created in the last 60 seconds that have 0 work journal entries. Or: rank sessions by work journal entry count, not just recency.
- **Files**: `src/agent-onboarding.ts` (session query, ~line 525)

### Task 3: Conversation memory role extraction
- **Problem**: The transcript query uses `metadata->>'role'` but 84 conversation memories have `null` role. Need to handle null roles gracefully.
- **Fix**: Default to `'unknown'` when role is null. Or check `metadata->>'source_kind'` for transcript entries.
- **Files**: `src/agent-onboarding.ts` (transcript section, ~line 685)

### Task 4: User messages not saved to memory before new session starts
- **Problem**: User messages are saved asynchronously. When the new session starts onboarding, the prior session's user messages may not yet be in the `memories` table.
- **Fix**: Query `chat_messages` table directly (not `memories`) for the conversation transcript. `chat_messages` is written synchronously by OpenCode and should have both user and assistant messages.
- **Investigation done**: `chat_messages` has columns: `content, created_at, id, metadata, project_id, role, thread_id`. No `session_id` — need to find how `thread_id` maps to sessions.
- **Files**: `src/agent-onboarding.ts` (transcript query replacement)

### Task 5: commit uncommitted working tree changes
- **Problem**: The dist/ has uncommitted changes from Phase 9A-Tune (handoff rewrite, config .env loader, system-transform onboarding-first, re-entry protocol default restore, AGENTS.md update, test updates).
- **Fix**: `git add` + commit with message like `feat: Phase 9A-Tune — onboarding continuity, .env loader, AGENTS.md update`
- **Files**: Multiple (see `git status`)

## Schema Reference
```
chat_messages: content, created_at, id, metadata, project_id, role, thread_id
sessions: id, project_id, directory, title, summary, turn_count, created_at, updated_at, ended_at
agent_work_journal: session_id, project_id, entry_type, tool_name, intent, result_summary, files_touched, error_summary, created_at
memories: id, content, memory_type, metadata (JSON), session_id, project_id, is_active, importance, created_at
```

## Key Files
- `src/agent-onboarding.ts` — orchestrator + 10 providers (~750 LOC)
- `src/agent-onboarding-tool.ts` — csm_onboard_agent tool
- `src/hooks/system-transform.ts` — injection point (onboarding FIRST)
- `src/config.ts` — .env loader
- `src/re-entry-protocol.ts` — DEFAULT_REENTRY_CONFIG (previewOnly: false)
- `test/agent-onboarding.test.ts` — 34 tests
- `AGENTS.md` — updated with Phase 9A progress

## Verification Commands
```bash
npm run build
npm test
npm run lint:src
```

## Acceptance
- Fresh agent session says "Phase 9A-Tune — onboarding continuity" without reading AGENTS.md
- Handoff shows last 8 turns (user + assistant) from prior session
- Handoff picks the PRIOR session, not the brand-new one
- 903+ tests pass, build clean, lint 7 warnings

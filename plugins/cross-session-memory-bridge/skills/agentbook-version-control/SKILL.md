---
name: agentbook-version-control
description: Coordinate Git and Cross-Session Memory as version control for agent work. Use when Codex needs AgentBook status, checkpoints, history, resume or handoff, provenance, isolated agent approaches, semantic comparison, or an evidence-backed game-development tuning and playtest iteration with an explicit keep or revert decision.
---

# AgentBook Version Control

Treat Git as the authority for files and AgentBook as the provenance layer for intent, evidence,
decisions, tests, and recovery state. Never represent AgentBook as a replacement for Git.

## Establish status

1. Inspect the current workspace, `git status`, and recent Git history before trusting recalled state.
2. Before the first CSM operation, call `csm_runtime_status`. Stop and report a provider or project-root mismatch.
3. Read `csm_agentbook_state`, recent `csm_agentbook_events`, `goal_list`, and `list_checkpoints` as needed.
4. Report status using five fields: workspace identity, active goal, latest checkpoint, verified evidence, and unresolved work.

Current files and test output outrank memory. Treat automatic event capture as a recovery log, not as a curated milestone.

## Create a checkpoint

Create a checkpoint before an expensive, risky, or branching change and after a verified outcome.
Include this information in the explicit message snapshot or milestone used to build it:

```text
goal:
parent/baseline:
git commit:
dirty-tree status or diff hash:
change:
reason:
expected effect:
verification:
actual result:
decision: keep | revert | unresolved
known risks:
next action:
```

Use `create_checkpoint` for recoverable session state. Use `bridge_sync_turn` only for a durable
milestone that automatic hooks cannot infer. Do not create redundant checkpoints for routine reads.

## Branch and compare work

- Use Git branches or worktrees for file isolation. Do not invent a second source-control system.
- Give each agent attempt one explicit goal, baseline Git identity, and checkpoint lineage note.
- Keep parallel attempts disjoint where possible. Never merge or delete a branch without the user's authorization.
- Compare attempts across code and agent state: file diff, decisions, evidence, tests, performance, cost, failures, and open risks.
- Apply only the selected artifacts through normal Git operations. Record why the result was kept, combined, or rejected.

Native cross-session checkpoint DAGs, semantic merge, blame, and bisect are future AgentBook
capabilities. Until they exist, describe the Git-backed workflow honestly.

## Run one game-development iteration

Translate the task into a player-facing hypothesis, then run the smallest representative experiment:

1. Define what the player should perceive, the input that triggers it, confirming feedback, failure, and the test scenario.
2. Capture a baseline checkpoint with the exact build or commit, starting conditions, controls, target frame rate, and current observation.
3. Change one meaningful variable or tightly coupled group. Record the old and new values.
4. Exercise the behavior in a running game or representative simulation. Code inspection alone is not a playtest.
5. Capture observable evidence: response time, timing, frame pacing, screenshots, video, logs, replay, or concrete player observations.
6. Decide `keep`, `revert`, or `unresolved`. Revert through Git or the editor only when that action is clearly authorized and scoped.
7. Create the outcome checkpoint and state the largest remaining player-facing problem.

Use this tuning record:

```text
player-facing goal:
baseline:
change:
reason:
expected player effect:
scenario and controls:
actual result:
performance conditions:
evidence:
decision: keep | revert | unresolved
remaining problem:
```

Use one completion status:

- `Verified Playable`: exercised in a running game or representative simulation and matched the player-facing goal.
- `Technically Verified`: deterministic checks passed; subjective play quality still needs a human playtest.
- `Self-Checked`: inspected only; representative runtime testing was unavailable.
- `Blocked`: a concrete missing requirement prevents a trustworthy verdict.

Never claim `Verified Playable` from code inspection or unit tests alone. Verify audio and visible feedback when the change affects them.

## Safety and handoff

- Do not perform schema migrations, bulk memory mutations, branch deletion, or configuration changes without explicit approval.
- Keep all CSM reads and writes scoped to the current project root.
- Redact credentials and unnecessary sensitive content before persistence.
- Before stopping or transferring work, call `bridge_handoff_summary` with the outcome, files changed, verification, open risks, checkpoint, and next action.

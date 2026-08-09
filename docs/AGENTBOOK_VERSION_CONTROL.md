# AgentBook Version Control

AgentBook is the product layer over Cross-Session Memory (CSM). It adds durable intent, evidence,
decisions, tests, and recovery state to the file history already owned by Git.

## Product boundary

- Git remains authoritative for source code, assets, branches, merges, tags, and working-tree state.
- AgentBook remains authoritative for agent goals, operational events, checkpoints, evidence,
  decisions, test claims, risks, and handoffs.
- Current workspace files and fresh verification always outrank recalled state.
- Automatic event capture is a recovery log. A checkpoint is the curated milestone.

AgentBook does not silently commit, merge, reset, delete branches, or mutate memory governance.

## Available vertical slice

The first complete workflow is deliberately small:

```text
inspect status
  → capture baseline checkpoint
  → make one scoped change
  → run a representative test or playtest
  → record observable evidence
  → keep, revert, or mark unresolved
  → capture outcome checkpoint and handoff
```

For parallel approaches, use Git worktrees as the file-isolation primitive. Give every attempt a
baseline Git identity, an explicit goal, and an AgentBook checkpoint. Compare code, evidence,
tests, performance, cost, failures, and open risks before selecting an outcome.

## Game-development profile

Game development is a strong proving ground because a code diff cannot capture whether a mechanic
feels responsive, an attack is readable, a camera hides hazards, or a performance change improves
worst-frame behavior.

One iteration records:

```text
player-facing goal:
baseline build or commit:
starting conditions and controls:
changed variable and exact old/new values:
expected player effect:
actual result:
frame-rate and performance conditions:
screenshots, video, logs, replay, or measurements:
decision: keep | revert | unresolved
largest remaining player-facing problem:
```

Only a running game or representative simulation can earn `Verified Playable`. Deterministic tests
without a playtest earn at most `Technically Verified`; inspection alone earns `Self-Checked`.

## Evolution path

The current Git-backed workflow should be validated before adding storage complexity. Later native
capabilities may include content-addressed checkpoints, first-class checkpoint parents, semantic
diffs, conflict-aware merge, claim blame, regression bisect, remote synchronization, and a visual
lineage client. Those capabilities must preserve project isolation and source attribution.

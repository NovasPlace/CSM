# Phase 5: Self-Optimizing Loop

## Goal

Close the feedback loop. CSM currently observes and advises (open-loop). Phase 5 lets the
model's *measured outcomes* shape its *future context* by tagging experience packets with
results, authoring procedural strategies, tracking their effectiveness, and injecting only
proven strategies as advisory guidance.

```
Experience ──▶ Outcome Tagging ──▶ Strategy Authoring ──▶ Effectiveness Tracking ──▶ Advisory Injection
   ▲                                                                                    │
   └────────────────────────────────────────────────────────────────────────────────────┘
```

## Design Principles

1. **Advisory-only.** No strategy auto-applies. The model sees suggestions, never commands.
2. **Human-reviewable.** Promotion from `draft` → `active` is gated by trial threshold + success
   rate. Every promotion is visible in the candidate queue and reversible.
3. **No vibes.** High-confidence `success` outcomes require hard signal (task completion, passing
   tests, explicit user/agent signal). `unknown` is the safe default.
4. **Non-imperative language.** Injected strategies never use "you must" / "always" / "do not".
   They state observed effectiveness and step history.
5. **Never override current user instructions.** The strategies section is appended after the
   context brief and explicitly defers to the active task.
6. **PG + SQLite parity.** Same column names, CHECK constraints, and indexes across both
   databases (per Phase 4B.5 vocabulary lock).

---

## Phase 5A — Outcome-Tagged Packets

### Schema Changes (ALTER TABLE on `experience_packets`)

```sql
ALTER TABLE experience_packets ADD COLUMN IF NOT EXISTS outcome TEXT
  NOT NULL DEFAULT 'unknown'
  CHECK (outcome IN ('success', 'failure', 'partial', 'blocked', 'unknown'));
ALTER TABLE experience_packets ADD COLUMN IF NOT EXISTS outcome_reason TEXT;
ALTER TABLE experience_packets ADD COLUMN IF NOT EXISTS outcome_confidence REAL
  NOT NULL DEFAULT 0.0 CHECK (outcome_confidence BETWEEN 0 AND 1);
ALTER TABLE experience_packets ADD COLUMN IF NOT EXISTS evidence_refs JSONB
  NOT NULL DEFAULT '[]';
ALTER TABLE experience_packets ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_experience_packets_outcome
  ON experience_packets(outcome) WHERE outcome != 'unknown';
```

### Outcome Semantics

| Outcome     | Meaning                                              | Min confidence for tag |
|-------------|------------------------------------------------------|------------------------|
| `success`   | Goal achieved — verified by hard signal              | 0.7                    |
| `failure`   | Goal not achieved, error not recovered               | 0.6                    |
| `partial`   | Some sub-goals met, others blocked/abandoned         | 0.5                    |
| `blocked`   | Could not proceed (missing dep, permission, env)     | 0.5                    |
| `unknown`   | No determination made (default, safe)                | 0.0                    |

### Confidence Calibration (Anti-Vibes Rule)

`outcome='success'` with `outcome_confidence >= 0.7` requires **at least one** hard signal:

| Signal source                  | How detected                                              |
|--------------------------------|-----------------------------------------------------------|
| Task completion                | `goal_update` with `status='achieved'`                    |
| Passing tests                  | `bash` tool exit code 0 on a `test`/`lint`/`typecheck` cmd|
| Explicit user signal           | User message affirms success ("that worked", "done")      |
| Explicit agent signal          | Model calls `csm_packet_resolve` tool with outcome        |
| Error recovery                 | `error` packet followed by `milestone` on same intent      |

Without any of these, `outcome` stays `unknown` (or `partial` at lower confidence). The model's
own assertion of success is **not** sufficient for `success` at high confidence.

### Fields

| Field                 | Type      | Notes                                                      |
|-----------------------|-----------|------------------------------------------------------------|
| `outcome`             | TEXT enum | `success|failure|partial|blocked|unknown` (default unknown)|
| `outcome_reason`      | TEXT      | Human-readable explanation of the determination            |
| `outcome_confidence`  | REAL 0-1  | Confidence in the outcome tag (distinct from packet `confidence`) |
| `evidence_refs`       | JSONB     | Array of refs: `{kind, id}` — test runs, checkpoints, packet IDs, memory IDs |
| `resolved_at`         | TIMESTAMPTZ | When the outcome was determined (may differ from `created_at`) |

### Resolution Path

A new tool `csm_packet_resolve` lets the model (or a post-task hook) tag a packet's outcome
after the fact. Auto-resolution hooks:
- `goal_update → achieved` → resolve matching packets to `success`
- `goal_update → abandoned` → resolve to `blocked` or `failure`
- Test/lint exit 0 → resolve recent `tool_execution` packets on same intent to `success`
- Test/lint exit non-0 → resolve to `failure` (confidence 0.7)

Unresolved packets retain `outcome='unknown'` and are excluded from strategy effectiveness
computation.

---

## Phase 5B — Strategy Memory Type

A dedicated `strategies` table (not overloading `memories` with `type='procedural'`). Strategies
have structured operational fields (triggers, steps, contraindications) that don't fit the
generic memories schema. A promoted strategy may *also* be saved as a `procedural` memory for
cross-session recall — the strategy table is the structured operational form; the memory is the
durable knowledge form.

### Schema

```sql
CREATE TABLE IF NOT EXISTS strategies (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  trigger_conditions JSONB NOT NULL DEFAULT '[]',
  steps JSONB NOT NULL DEFAULT '[]',
  expected_result TEXT,
  contraindications JSONB NOT NULL DEFAULT '[]',
  source_evidence_refs JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'deprecated', 'suppressed')),
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  trial_count INTEGER NOT NULL DEFAULT 0,
  decayed_success_rate REAL NOT NULL DEFAULT 0.0,
  min_trial_threshold INTEGER NOT NULL DEFAULT 5,
  promotion_ready BOOLEAN NOT NULL DEFAULT false,
  project_id TEXT,
  memory_id BIGINT REFERENCES memories(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_applied_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_strategies_status ON strategies(status);
CREATE INDEX IF NOT EXISTS idx_strategies_project ON strategies(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_strategies_name_project
  ON strategies(name, COALESCE(project_id, ''));
```

### Field Reference

| Field                  | Type      | Description                                                        |
|------------------------|-----------|--------------------------------------------------------------------|
| `name`                 | TEXT      | Human-readable, unique per project                                 |
| `description`          | TEXT      | What the strategy is for                                           |
| `trigger_conditions`   | JSONB     | Array of `{field, operator, value}` — e.g. `{field:"entryType", operator:"equals", value:"error"}` |
| `steps`                | JSONB     | Ordered array of step strings (the playbook)                      |
| `expected_result`      | TEXT      | What success looks like                                            |
| `contraindications`    | JSONB     | Array of strings — when NOT to use this strategy                   |
| `source_evidence_refs` | JSONB     | Array of `{kind, id}` — packets, attempts, memories that informed it |
| `status`               | TEXT enum | `draft` (unproven) → `active` (promoted) → `deprecated`/`suppressed` |
| `success_count`        | INTEGER   | Trials with `outcome='success'`                                   |
| `failure_count`        | INTEGER   | Trials with `outcome='failure'`                                   |
| `trial_count`          | INTEGER   | Total resolved trials (success + failure + partial)               |
| `decayed_success_rate` | REAL 0-1  | Time-decayed success rate (see 5C)                                 |
| `min_trial_threshold`  | INTEGER   | Min trials before promotion-eligible (default 5)                  |
| `promotion_ready`      | BOOLEAN   | Computed: trial_count >= threshold AND decayed_rate >= promotion_threshold |
| `project_id`           | TEXT      | Scoped to project (nullable = global)                             |
| `memory_id`            | BIGINT FK | Optional link to a `procedural` memory once promoted              |

### Trigger Condition Operators

| Operator   | Matches                                              |
|------------|------------------------------------------------------|
| `equals`   | Exact match on a context field                       |
| `contains` | Context field contains value                         |
| `regex`    | Context field matches regex                          |
| `gt`/`lt`  | Numeric comparison                                   |
| `gte`/`lte`| Numeric comparison (inclusive)                       |

Context fields available for matching: `entryType`, `toolName`, `stance`, `dominantEmotion`,
`urgency`, `frustration`, `projectId`, `intent` (substring).

### Authoring Tools

| Tool                    | Purpose                                              |
|-------------------------|------------------------------------------------------|
| `csm_strategy_save`     | Create or update a `draft` strategy                  |
| `csm_strategy_list`     | List strategies with filters (status, project)       |
| `csm_strategy_review`   | Inspect a strategy's trials, success rate, evidence  |
| `csm_strategy_promote`  | Explicitly promote `draft` → `active` (human gate)   |
| `csm_strategy_deprecate`| Move `active` → `deprecated` or `suppressed`         |

The belief scanner (Phase 4C-A) is extended to emit `candidate_strategy` candidates when a
recurring successful pattern is detected across ≥ `min_trial_threshold` packets with the same
context fingerprint.

---

## Phase 5C — Effectiveness Tracking

### Schema

```sql
CREATE TABLE IF NOT EXISTS strategy_attempts (
  id BIGSERIAL PRIMARY KEY,
  strategy_id BIGINT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  project_id TEXT,
  context_fingerprint TEXT NOT NULL,
  trigger_matched JSONB NOT NULL DEFAULT '{}',
  outcome TEXT NOT NULL DEFAULT 'unknown'
    CHECK (outcome IN ('success', 'failure', 'partial', 'blocked', 'unknown')),
  outcome_reason TEXT,
  outcome_confidence REAL NOT NULL DEFAULT 0.0 CHECK (outcome_confidence BETWEEN 0 AND 1),
  evidence_refs JSONB NOT NULL DEFAULT '[]',
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_strategy_attempts_strategy ON strategy_attempts(strategy_id);
CREATE INDEX IF NOT EXISTS idx_strategy_attempts_outcome ON strategy_attempts(strategy_id, outcome);
CREATE INDEX IF NOT EXISTS idx_strategy_attempts_applied ON strategy_attempts(applied_at DESC);
```

### Recording an Attempt

When a strategy's triggers match the current context AND the model applied its steps (or the
steps were suggested and the model followed a recognizable path), an attempt is recorded:

1. `applied_at` = when the strategy was surfaced/applied
2. `context_fingerprint` = hash of matched trigger conditions + key context signals
3. `outcome` = `unknown` at insert time
4. `resolved_at` = null until outcome determined

Outcome is resolved later via the same signals as 5A (task completion, tests, explicit signal).
Unresolved attempts (`outcome='unknown'`) do not count toward `trial_count` or success rate.

### Success Rate with Decay

Raw success rate: `success_count / trial_count`.

Decayed success rate uses exponential decay so recent trials weigh more:

```
weight_i   = 0.5 ^ ((now - applied_at_i).days / half_life_days)
decayed_rate = Σ(weight_i * is_success_i) / Σ(weight_i)
```

Default `half_life_days = 30`. Decay is recomputed by a periodic scanner (not on every write),
batched like the belief scanner.

### Minimum Trial Threshold

`promotion_ready` is computed by the scanner:

```
promotion_ready = (trial_count >= min_trial_threshold)
              AND (decayed_success_rate >= promotion_threshold)
              AND (status = 'draft')
```

Defaults: `min_trial_threshold = 5`, `promotion_threshold = 0.6`.

Below threshold, the strategy stays `draft` and is **not** injected into the advisory block.

### Demotion

A scanner also flags demotion candidates:
- `active` strategy with `decayed_success_rate < 0.3` over last `min_trial_threshold` trials →
  `candidate_strategy_demote` in the candidate queue
- Stale strategy (no attempts in 90 days) → `candidate_strategy_deprecate`

### Candidate Queue Extension

Add two candidate types to the unified queue:

```
'candidate_strategy_promote'   -- draft → active when threshold met
'candidate_strategy_demote'    -- active → deprecated/suppressed when success drops
```

These follow the same advisory/dry-run pattern as existing candidates (Phase 4C-B).

---

## Phase 5D — Advisory Injection

### New Advisory Section: `provenStrategies`

Added to the living state advisory block after `candidateBeliefs`, before `warnings`:

```
Proven strategies (advisory, not truth — ignore if contradicted by current task):
- [type-error-import-check] success=0.82 (14 trials) — trigger: entryType=error
  Steps: 1) grep for import of failing symbol 2) check package.json 3) check tsconfig paths
  When not to use: error is a runtime crash, not a type error
```

### Injection Rules

1. **Only proven strategies.** Inject only where `status='active'` AND
   `trial_count >= min_trial_threshold` AND `decayed_success_rate >= promotion_threshold`.
2. **Relevance match.** Match current context fingerprint against `trigger_conditions`. Only
   inject matched strategies. No match → no injection.
3. **Advisory labeling.** Every entry starts with the disclaimer line. Each strategy line
   includes success rate, trial count, trigger, steps, and contraindications.
4. **Cap on count.** `maxInjectedStrategies` config (default 3). When over cap, drop lowest
   `decayed_success_rate` first.
5. **Never override user instructions.** The disclaimer explicitly states "ignore if
   contradicted by current task instructions." The section is appended after the context brief
   (lower prompt priority).
6. **Non-imperative language.** Steps are stated as observed history ("Steps: 1) ... 2) ..."),
   never as commands ("You must ...").

### Budget Trimming Order

The existing trim order (Phase 4F-B) drops sections to fit `maxAdvisoryBlockChars`:

```
drop first                                          drop last
candidateBeliefs → provenStrategies → recentSignals → capabilityNotes → warnings
```

`provenStrategies` drops after `candidateBeliefs` (most speculative) but before
`recentSignals`/`capabilityNotes`/`warnings`. `warnings` survive longest (unchanged from 4F-B).

### Config Flags (Staged Enablement)

```bash
CSM_STRATEGY_ENABLED=false           # master switch (default off)
CSM_STRATEGY_INJECT=false            # inject into advisory block (default off)
CSM_STRATEGY_MAX_INJECTED=3          # cap on injected strategies
CSM_STRATEGY_MIN_TRIALS=5            # min trials before promotion-eligible
CSM_STRATEGY_PROMOTION_THRESHOLD=0.6 # min decayed success rate for promotion
CSM_STRATEGY_DECAY_HALF_LIFE_DAYS=30 # exponential decay half-life
```

Staged rollout mirrors Phase 4F-C:
- **Stage 1:** `CSM_STRATEGY_ENABLED=true`, `INJECT=false` — schema + tracking only, inspect via tools
- **Stage 2:** `INJECT=true` locally — observe advisory block across several sessions
- **Stage 3:** Decision point — tune caps/thresholds or keep disabled

---

## PG ↔ SQLite Schema Mapping

| PG type         | SQLite type              | Notes                              |
|-----------------|--------------------------|------------------------------------|
| BIGSERIAL       | INTEGER AUTOINCREMENT    | PK generation                       |
| TEXT            | TEXT                     | Identical                           |
| JSONB           | TEXT                     | Stored as JSON string               |
| REAL            | REAL                     | Identical                           |
| TIMESTAMPTZ     | TEXT                     | ISO 8601 string                     |
| BOOLEAN         | INTEGER                  | 0/1 in SQLite                       |

All column names, CHECK constraints, and indexes identical between PG and SQLite schemas (per
Phase 4B.5 vocabulary lock). SQLite schema additions go in `src/schema/sqlite/index.ts`.

---

## Cross-Cutting Concerns

### Advisory-Only Philosophy

- No strategy is auto-applied. The model sees suggestions in the advisory block.
- No memory writes occur from strategy injection.
- The candidate queue gates all promotions/demotions (dry-run by default, human-reviewable).

### Human-Reviewable Promotion

| Path                           | Gate                                              |
|--------------------------------|---------------------------------------------------|
| Auto-promote (scanner)         | `candidate_strategy_promote` in queue (advisory)  |
| Manual promote                 | `csm_strategy_promote` tool (explicit)            |
| Auto-demote (scanner)          | `candidate_strategy_demote` in queue (advisory)   |
| Manual deprecate               | `csm_strategy_deprecate` tool (explicit)          |

All promotions/demotions are visible via `csm_memory_candidate_report` and reversible (status
can be changed back; no deletes).

### Feedback Loop Safety

- **Exploration:** Strategies with few trials don't get suppressed — they stay `draft` until
  threshold met or stale.
- **Diversity:** The scanner dedupes by context fingerprint, preventing one dominant strategy
  from crowding out alternatives.
- **Decay:** Old successes fade, so a strategy that worked months ago but fails now will
  demote naturally.
- **Contradiction penalty:** If a strategy's trials show mixed outcomes (high variance), its
  `decayed_success_rate` stays near 0.5 and it won't promote.

---

## Phased Rollout

| Sub-phase | Scope                                          | Deliverables                                    |
|-----------|------------------------------------------------|-------------------------------------------------|
| 5A        | Outcome-tagged packets                         | ALTER TABLE, `csm_packet_resolve` tool, auto-resolution hooks, tests |
| 5B        | Strategy memory + authoring tools              | `strategies` table, 5 tools, scanner extension, tests |
| 5C        | Effectiveness tracking                         | `strategy_attempts` table, decay computation, promotion gate, 2 candidate types, tests |
| 5D        | Advisory injection                             | `provenStrategies` section, relevance matcher, budget trimming, config flags, tests |

Each sub-phase is independently shippable. 5A has no dependencies beyond Phase 4A. 5B depends
on 5A (needs outcome-tagged packets as evidence). 5C depends on 5B (needs strategies to track).
5D depends on 5C (needs effectiveness data to inject).

---

## Acceptance Criteria

| #  | Criterion                                                              | Sub-phase |
|----|------------------------------------------------------------------------|-----------|
| 1  | `outcome` defaults to `unknown`; no packet is tagged `success` without a hard signal | 5A        |
| 2  | `csm_packet_resolve` tool tags outcome with reason + confidence        | 5A        |
| 3  | Auto-resolution hooks fire on goal_update and test exit codes          | 5A        |
| 4  | `strategies` table exists with all fields and CHECK constraints (PG + SQLite) | 5B        |
| 5  | `csm_strategy_save` creates draft strategies; `csm_strategy_list` filters by status/project | 5B        |
| 6  | Scanner emits `candidate_strategy` when recurring success pattern detected | 5B        |
| 7  | `strategy_attempts` records each application with context fingerprint  | 5C        |
| 8  | Decayed success rate computed with configurable half-life              | 5C        |
| 9  | `promotion_ready` only true when trial_count >= threshold AND rate >= gate | 5C        |
| 10 | Demotion candidates emitted when active strategy success drops < 0.3   | 5C        |
| 11 | Advisory block includes `provenStrategies` only when `CSM_STRATEGY_INJECT=true` | 5D        |
| 12 | Only `active` + threshold-met + trigger-matched strategies injected    | 5D        |
| 13 | Each injected line includes success rate, trial count, steps, contraindications | 5D        |
| 14 | `maxInjectedStrategies` cap enforced; lowest rate dropped first       | 5D        |
| 15 | Disclaimer line present: "advisory, not truth — ignore if contradicted" | 5D        |
| 16 | No imperative language in injected strategies                          | 5D        |
| 17 | `provenStrategies` drops before `warnings` in budget trimming         | 5D        |
| 18 | All schema changes have PG + SQLite parity                             | 5A-5D     |

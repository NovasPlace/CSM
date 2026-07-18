# RUNBOOK.md

> Operational runbook. Updated by auto-docs hook.

## Startup

1. Ensure PostgreSQL is running.
2. Set `CSM_DATABASE_URL`.
3. Ensure the `vector` extension exists.
4. Start the plugin. PostgreSQL schema initialization is serialized with a transaction-scoped advisory lock and runs atomically. An unexpected schema failure rolls back and aborts startup.
5. For Codex-hosted usage, import `dist/codex-bridge.js` instead of starting the OpenCode plugin hooks.

PostgreSQL transport controls are `CSM_DB_POOL_MAX`, `CSM_DB_CONNECTION_TIMEOUT_MS`, `CSM_DB_STATEMENT_TIMEOUT_MS`, `CSM_DB_IDLE_TIMEOUT_MS`, and `CSM_DB_TLS_MODE`. TLS mode `url` preserves the connection string policy, `disable` forbids TLS, `require` encrypts without certificate verification, and `verify-full` requires certificate and hostname verification. Production should use `verify-full` with a trusted system CA or `sslrootcert` in `CSM_DATABASE_URL`.

## Health Checks

### Machine-readable Diagnostics

`Database.diagnose()` returns a JSON-safe object with the provider, startup state, liveness, readiness probe latency/reason, and PostgreSQL pool counts when available:

```ts
const diagnostic = await database.diagnose();
if (diagnostic.readiness.status !== 'pass') process.exitCode = 1;
process.stdout.write(`${JSON.stringify(diagnostic)}\n`);
```

Liveness passes when the diagnostic code can execute. Readiness passes only after schema startup reaches `ready` and a real `SELECT 1` probe succeeds. Startup states are `idle`, `connecting`, `migrating`, `ready`, `failed`, and `closed`.

### Database Connectivity

```bash
node -e "const {Pool}=require('pg');new Pool({connectionString:process.env.CSM_DATABASE_URL}).query('SELECT 1').then(r=>console.log('OK:',r.rows)).catch(e=>console.error('FAIL:',e.message))"
```

### Schema Integrity

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;
```

Expected core tables:
- `sessions`
- `memories`
- `memory_chunks`
- `memory_events`
- `memory_recall_events`
- `session_contexts`
- `goals`
- `memory_links`

### Embedding Coverage

```sql
SELECT COUNT(*) AS total, COUNT(embedding) AS with_embedding
FROM memories;
```

### Recall Telemetry Coverage

```sql
SELECT COUNT(*) AS recall_events, COUNT(DISTINCT memory_id) AS recalled_memories
FROM memory_recall_events;
```

### Migration History

```sql
SELECT migration_id, checksum, provider, execution_ms, applied_at
FROM csm_schema_migrations
ORDER BY migration_id;
```

Startup rejects changed implementation checksums, migrations unknown to the running release, history copied from another provider, and every failed required migration including ownership failures. PostgreSQL applies pending migrations inside the advisory-locked schema transaction; SQLite applies its baseline inside `BEGIN IMMEDIATE`.

Artifact verification is cross-platform: uniform CRLF text is canonicalized to LF before SHA-256 comparison, while mixed LF/CRLF or bare-CR text is rejected. Unrecognized and binary artifacts are hashed byte-for-byte. A `sourceSha256` pin freezes an evolved current source and is included in the checksum recorded by fresh databases. The manifest separately derives and accepts the original artifact-set checksum for historical PostgreSQL ledgers; no arbitrary checksum is accepted.

### Work Ledger lineage

Use `csm_work_ledger_surviving` to answer which changes from a run still survive. The query performs a live filesystem verification before returning active or partially-superseded rows.

```sql
SELECT change_id, run_id, model_id, tool_call_id, file_path, status,
       superseded_by, supersedes, patch_hash, surviving_patch_hash
FROM work_ledger_changes
WHERE run_id = $1
ORDER BY created_at;
```

See `WORK_LEDGER.md` for capture surfaces, status semantics, path containment, and the Codex two-phase adapter.

The supported upgrade window and restore-based rollback procedure are defined in `SCHEMA_SUPPORT_MATRIX.md`. Never delete migration ledger rows or reverse production DDL manually.

## Cold-Start Source Attribution Diagnostic

**Purpose:** prove that CSM injection (onboarding + re-entry blocks) materially contributes to a fresh session's context, not just the static `AGENTS.md` file. This is the observation-window test referenced in `AGENTS.md` → "Next Steps".

### Step 1 — Capture baseline counts

```bash
$env:PGUSER='postgres'; $env:PGPASSWORD='postgres'
$env:DATABASE_URL='postgresql://postgres:postgres@localhost:5432/opencode_memory'
node .tmp_opencode_diag/attribution_breakdown.cjs   # see stats by injection_kind
```

Record current `event_count` for `onboarding` and `reentry` — these are the baseline for the new cold-start session.

### Step 2 — Launch a fresh opencode session in this repo

From a terminal:

```powershell
opencode
```

Then ask anything that requires prior-session context (forces onboarding + re-entry to fire). Good prompts:

- *"what phase is the project in right now?"* — exercises phase-checkpoint + recent-work layers
- *"what's the current lint baseline?"* — exercises constraints + key-decisions layers
- *"summarize recent decisions"* — exercises belief-knowledge + advisories layers

Both `injection_kind='onboarding'` and `injection_kind='reentry'` rows are written by `ContextInjectionLogger.logInjection()` from `onboarding-injection-guard.ts:30` and `reentry-injection-guard.ts:46` regardless of the prompt — the prompt only affects what the agent *uses*, not whether telemetry fires.

### Step 3 — Verify new rows landed

```bash
node .tmp_opencode_diag/attribution_breakdown.cjs
```

Expect:
- One new `onboarding` event + one new `reentry` event for the new `session_id`
- Onboarding block: ~11–12k chars, ~2.9–3.2k tokens, `trim_level='none'`
- Re-entry block: ~3k chars, ~750 tokens, `trim_level='soft'`, `metadata.budgetTier='short'`

### Step 4 — Read the attribution breakdown

The schema distinguishes CSM vs AGENTS.md via `context_injection_items.source_id` (not `source_kind`). The expected attribution split for a normal session:

**Onboarding block layers:**
| Layer | `source_id` | Attribution |
|-------|-------------|-------------|
| `identity-brief` | `AGENTS.md + defaults` | AGENTS.md |
| `project-continuity` | `package.json + README + filesystem` | CSM (live scan) |
| `phase-checkpoint` | `AGENTS.md` | AGENTS.md |
| `constraints` | `hardwired + AGENTS.md` | mixed |
| `relevant-memories` | `memory store` | CSM (DB query) |
| `promoted-beliefs` | `belief_knowledge_store` | CSM |
| `advisories` | `living-state pipeline` | CSM |
| `tool-guidance` | `defaults + AGENTS.md` | mixed |
| `handoff-state` | `sessions + work_journal + chat_messages + memories + .csm/` | CSM |
| `readiness-summary` | `synthesis of all sections` | CSM |

**Re-entry block layers:** 8 layers (`identity`, `goals`, `work`, `preferences`, `capabilities`, `beliefs`, `recent`, `constraints`) — all `source_id='reentry-layer:*'`, **100% CSM-derived, no AGENTS.md dependency**.

### Step 5 — Confirm the agent actually used CSM context

This is the soft test the schema cannot answer alone — the rows prove injection happened, not that the model cited it. Quick check: in the fresh session, ask the agent *"without reading any files, what phase is the project in?"*. If it cites "Phase 9B / observation window" or the 7-warning lint baseline, that's CSM-derived (not in AGENTS.md verbatim under a section the model would quote cold). If it recites `## Constraints` or `## Key Decisions` bullet-for-bullet, that's AGENTS.md.

### Findings as of 2026-07-16

- **Live DB:** `opencode_memory` (NOT `cross_session_memory` — that one is stale, missing the injection tables)
- **Baseline claim in `AGENTS.md` is wildly stale:** says "3 events (1 onboarding, 2 reentry)"; actual is **141 events (76 onboarding + 65 reentry) across 30 unique sessions** since 2026-07-13
- **Wiring works:** every fresh session in this repo produces paired onboarding + re-entry rows with full per-layer provenance
- **Attribution quality gap:** `source_kind` schema has `'memory' | 'document_section' | 'derived_state'`, but only 1 of 1064 items used `memory` — the `relevant-memories` layer emits `derived_state` with `source_id='memory store'` instead of per-memory items with `source_kind='memory'`. The provenance is recoverable from `source_id` but item-level memory attribution is lost.

## Common Operations

### Manual Embedding Backfill

Use the runtime tool `memory_backfill_embeddings`.

Rules:
- It only scans rows where `memories.embedding IS NULL`.
- It never runs automatically on startup.
- Start with `dryRun=true` on large legacy databases.

### Codex Bridge Bootstrap

Use `CodexMemoryBridge.connect({ databaseUrl, ...config })`.

Recommended first call per task:

```ts
const bridge = await CodexMemoryBridge.connect({ databaseUrl: process.env.CSM_DATABASE_URL });
const brief = await bridge.getContextBrief({
  projectRoot: process.cwd(),
  task: 'repair fresh schema contract drift',
});
```

Bridge operations:
- `save_memory`
- `search_memories`
- `list_memories`
- `get_context_brief`
- `recall_lessons`
- `prune_memories_dry_run`
- `backfill_missing_embeddings`
- `get_compaction_report`

The complete list above requires PostgreSQL. SQLite core mode supports save, search, list, context brief, and lesson recall; the bridge reports PostgreSQL-only operations as unavailable instead of attempting incompatible queries.

### SQLite Core Mode

```bash
export CSM_DATABASE_PROVIDER=sqlite
export CSM_SQLITE_PATH=.data/csm-memory.db
```

SQLite is a local core-memory adapter with text-search fallback. It does not provide PostgreSQL vector search, governance jobs, graph-wide maintenance, living-state services, or the PostgreSQL TUI dashboard.

### Safe Review Copy

If you need a clean throwaway copy for inspection, prefer the local helper instead of downloading a ZIP and expanding it in PowerShell.

```powershell
.\scripts\safe-review-copy.ps1
```

If you need an archive for offline review, use the helper with `-Archive`:

```powershell
.\scripts\safe-review-copy.ps1 -Archive
```

### Session Schema Repair

```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS turn_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
```

### Backup Memories

```bash
pg_dump -Fc "$CSM_DATABASE_URL" > memories_backup.dump
```

### Restore Memories

```bash
pg_restore -Fc -d "$CSM_DATABASE_URL" memories_backup.dump
```

### Isolated Backup/Restore Drill

Run the destructive proof only against the temporary databases created by the drill:

```bash
npm run drill:backup-restore
```

The command requires `CSM_DATABASE_URL` and PostgreSQL client tools matching the server major version. It preserves connection URL TLS parameters, passes the decoded password through `PGPASSWORD`, creates uniquely named source and restore databases, verifies migration history and sentinel data after `pg_restore`, and reports success only after both databases and the temporary dump are confirmed removed. Set `CSM_PG_BIN` to the matching client `bin` directory when the tools are not on `PATH`; `CSM_PG_TOOL_TIMEOUT_MS` defaults to 120000.

The complete local enterprise gate is:

```bash
npm run verify:enterprise
```

For a scale and recovery-objective run, set the record count and thresholds explicitly:

```bash
CSM_DRILL_MEMORY_COUNT=50000 CSM_DRILL_MAX_RTO_MS=30000 CSM_DRILL_MAX_DATA_LOSS=0 npm run drill:backup-restore
```

The drill emits a JSON report containing backup time, restore-and-validate RTO, record-loss RPO, source/restored counts, migration count, and cleanup status. On 2026-07-09, the local PostgreSQL 16 representative-scale run restored and validated 50,000 memories in 1,337.02 ms, lost 0 records, and removed both temporary databases and the dump. This is local engineering evidence, not a production-environment SLO.

## Monitoring Queries

### Memory Distribution by Type

```sql
SELECT memory_type, COUNT(*), AVG(importance)
FROM memories
GROUP BY memory_type
ORDER BY COUNT(*) DESC;
```

### Most Recalled Memories

```sql
SELECT memory_id, COUNT(*) AS recall_count
FROM memory_recall_events
GROUP BY memory_id
ORDER BY recall_count DESC
LIMIT 20;
```

### Concept Graph Density

```sql
SELECT jsonb_array_elements_text(shared_entities) AS concept, COUNT(*) AS links
FROM memory_links
GROUP BY concept
ORDER BY links DESC
LIMIT 20;
```

## Troubleshooting

| Problem | Check | Fix |
|---------|-------|-----|
| Hybrid search empty | `SELECT COUNT(*) FROM memories WHERE embedding IS NOT NULL` | Run explicit embedding backfill |
| Prune is too aggressive | `SELECT COUNT(*) FROM memory_recall_events` | Verify recall telemetry is being written |
| Codex starts cold every time | `npx tsx --test test/codex-bridge.test.ts` | Call `get_context_brief(projectRoot, task)` before task work |
| Fresh install behaves differently | Run `test/fresh-schema-contract.test.ts` | Repair schema/runtime drift before release |
| Startup fails during schema initialization | Read the named `SchemaStepError` step and database cause | Correct the failing DDL or ownership boundary; startup intentionally does not continue on a partial schema |

Production-equivalent infrastructure must repeat and ratify the backup/RPO/RTO thresholds before certification; see `ENTERPRISE_READINESS.md`.

## Test Suites

Current source of truth: `npm.cmd test` reports the exact current totals. The suite includes fresh-schema and Phase 19b integration coverage.

Representative DB-backed suites:
- `hybrid-search`
- `goal`
- `fresh-schema-contract`
- `backfill-recall-telemetry`
- `codex-bridge`
- `context-cache-store`

## Commands
**C:/Users/Donovan/Desktop/cross-session-memory/test/context-injection-contract.test.ts** (2026-07-13)
import assert from 'node:assert/strict';
import { it, describe, before, after, beforeEach } from 'node:test';
import { mkdirSync, rmSync } from 'node:fs';
import { Database } from '../src/database.js';
import { ReEntryProtocol } from '../src/re-entry-protocol.js';
import {
  BUILDER_VERSION,
  computeConfigHash,
  validateBuiltContextInjection,
  type BuiltContextInjection,
  type ContextInjectionItem,
} from '../src/context-injection-contract.js';
import { DEFAULT_REENTRY_CONFIG } from '../src/...

**test/sqlite-plugin-lifecycle-probe.mjs** (2026-07-13)
import plugin from '../dist/index.js';
import { writeFile } from 'node:fs/promises';

const workspace = process.argv[2];
const hooks = await plugin(
  { directory: workspace, worktree: workspace, client: {} },
  { databaseProvider: 'sqlite', sqlitePath: process.env.CSM_SQLITE_PATH },
);
const output = { system: [] };
await hooks['experimental.chat.system.transform']({
  sessionID: 'sqlite-lifecycle-session',
  messages: [{ role: 'user', content: 'inspect the current project' }],
}, o...

**test/governor-profile-fallback.test.ts** (2026-07-15)
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { getEffectiveGovernorThresholds } from '../src/context-governor.js';
import { DEFAULT_GOVERNOR_CONFIG, getGovernorProfile } from '../src/context-governor-profiles.js';

it('falls back to balanced thresholds for an unknown runtime profile', () => {
  const config = { ...DEFAULT_GOVERNOR_CONFIG, profiles: { ...DEFAULT_GOVERNOR_CONFIG.profiles } };
  const profile = getGovernorProfile(config, 'missing_profile' as never...

**test/memory-extractor-dedup.test.ts** (2026-07-16)
import { strict as assert } from 'assert';
import { test } from 'node:test';
import { MemoryExtractor } from '../src/memory-extractor.js';
import type { Memory, MemoryManager } from '../src/memory-manager.js';
import type { Database } from '../src/database.js';
import type { ExtractorConfig } from '../src/types.js';

const testConfig: ExtractorConfig = {
  enabled: true,
  minTurnsBeforeExtract: 1,
  maxCandidatesPerTurn: 5,
  confidenceThreshold: 0.5,
  autoApproveThreshold: 0.8,
}...

import type { DatabasePool } from '../types.js';
import { getLogger } from '../logger.js';
import { AGENTBOOK_EVENT_TYPES } from '../agentbook-types.js';

const EVENT_TYPE_LIST = AGENTBOOK_EVENT_TYPES.map((type) => `'${type}'`).join(', ');

const PG_EVENTS_DDL = `
  CREATE TABLE IF NOT EXISTS agentbook_events (
    event_id      TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL,
    session_id    TEXT,
    event_type    TEXT NOT NULL CHECK (event_type IN (${EVENT_TYPE_LIST})),
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor         TEXT NOT NULL DEFAULT 'agent',
    summary       TEXT NOT NULL,
    evidence_refs JSONB NOT NULL DEFAULT '[]',
    files         JSONB NOT NULL DEFAULT '[]',
    command       TEXT,
    result        TEXT,
    environment   JSONB NOT NULL DEFAULT '{}',
    metadata      JSONB NOT NULL DEFAULT '{}',
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'resolved'))
  )
`;

const PG_SUMMARIES_DDL = `
  CREATE TABLE IF NOT EXISTS agentbook_summaries (
    summary_id      TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL,
    from_event_id   TEXT NOT NULL REFERENCES agentbook_events(event_id) ON DELETE RESTRICT,
    to_event_id     TEXT NOT NULL REFERENCES agentbook_events(event_id) ON DELETE RESTRICT,
    event_count     INT NOT NULL DEFAULT 0,
    summary         TEXT NOT NULL,
    open_questions  JSONB NOT NULL DEFAULT '[]',
    decisions       JSONB NOT NULL DEFAULT '[]',
    failures        JSONB NOT NULL DEFAULT '[]',
    next_steps      JSONB NOT NULL DEFAULT '[]',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    model           TEXT,
    source_hash     TEXT NOT NULL
  )
`;

const PG_CURRENT_STATE_DDL = `
  CREATE TABLE IF NOT EXISTS agentbook_current_state (
    project_id        TEXT PRIMARY KEY,
    active_goal        TEXT,
    current_phase      TEXT,
    latest_summary_id  TEXT REFERENCES agentbook_summaries(summary_id) ON DELETE SET NULL,
    recent_changes     JSONB NOT NULL DEFAULT '[]',
    blockers           JSONB NOT NULL DEFAULT '[]',
    next_steps         JSONB NOT NULL DEFAULT '[]',
    rules_version      INT NOT NULL DEFAULT 0,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    event_count        INT NOT NULL DEFAULT 0,
    session_count      INT NOT NULL DEFAULT 0
  )
`;

const PG_RULES_DDL = `
  CREATE TABLE IF NOT EXISTS agentbook_rules (
    rule_id         TEXT PRIMARY KEY,
    scope           TEXT NOT NULL DEFAULT 'project' CHECK (scope IN ('project', 'session', 'global')),
    priority        INT NOT NULL DEFAULT 0,
    "trigger"       TEXT,
    instruction     TEXT NOT NULL,
    override_policy TEXT NOT NULL DEFAULT 'augment' CHECK (override_policy IN ('override', 'augment', 'block')),
    version         INT NOT NULL DEFAULT 1,
    active          BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

const SQLITE_EVENTS_DDL = `
  CREATE TABLE IF NOT EXISTS agentbook_events (
    event_id      TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL,
    session_id    TEXT,
    event_type    TEXT NOT NULL CHECK (event_type IN (${EVENT_TYPE_LIST})),
    occurred_at   TEXT NOT NULL DEFAULT (datetime('now')),
    actor         TEXT NOT NULL DEFAULT 'agent',
    summary       TEXT NOT NULL,
    evidence_refs TEXT NOT NULL DEFAULT '[]',
    files         TEXT NOT NULL DEFAULT '[]',
    command       TEXT,
    result        TEXT,
    environment   TEXT NOT NULL DEFAULT '{}',
    metadata      TEXT NOT NULL DEFAULT '{}',
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'resolved'))
  )
`;

const SQLITE_SUMMARIES_DDL = `
  CREATE TABLE IF NOT EXISTS agentbook_summaries (
    summary_id      TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL,
    from_event_id   TEXT NOT NULL REFERENCES agentbook_events(event_id) ON DELETE RESTRICT,
    to_event_id     TEXT NOT NULL REFERENCES agentbook_events(event_id) ON DELETE RESTRICT,
    event_count     INTEGER NOT NULL DEFAULT 0,
    summary         TEXT NOT NULL,
    open_questions  TEXT NOT NULL DEFAULT '[]',
    decisions       TEXT NOT NULL DEFAULT '[]',
    failures        TEXT NOT NULL DEFAULT '[]',
    next_steps      TEXT NOT NULL DEFAULT '[]',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    model           TEXT,
    source_hash     TEXT NOT NULL
  )
`;

const SQLITE_CURRENT_STATE_DDL = `
  CREATE TABLE IF NOT EXISTS agentbook_current_state (
    project_id        TEXT PRIMARY KEY,
    active_goal        TEXT,
    current_phase      TEXT,
    latest_summary_id  TEXT REFERENCES agentbook_summaries(summary_id) ON DELETE SET NULL,
    recent_changes     TEXT NOT NULL DEFAULT '[]',
    blockers           TEXT NOT NULL DEFAULT '[]',
    next_steps         TEXT NOT NULL DEFAULT '[]',
    rules_version      INTEGER NOT NULL DEFAULT 0,
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    event_count        INTEGER NOT NULL DEFAULT 0,
    session_count      INTEGER NOT NULL DEFAULT 0
  )
`;

const SQLITE_RULES_DDL = `
  CREATE TABLE IF NOT EXISTS agentbook_rules (
    rule_id         TEXT PRIMARY KEY,
    scope           TEXT NOT NULL DEFAULT 'project' CHECK (scope IN ('project', 'session', 'global')),
    priority        INTEGER NOT NULL DEFAULT 0,
    "trigger"       TEXT,
    instruction     TEXT NOT NULL,
    override_policy TEXT NOT NULL DEFAULT 'augment' CHECK (override_policy IN ('override', 'augment', 'block')),
    version         INTEGER NOT NULL DEFAULT 1,
    active          BOOLEAN NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  )
`;

/**
 * AgentBook: append-only operational ledger (agentbook_events) plus derived
 * rolling summaries, a single-row-per-project current-state projection, and
 * an explicit rules table. Sits above CSM memories/experience-packets as the
 * agent's working autobiography and cold-start injection source.
 *
 * Additive only, idempotent, dialect-aware (single source of truth for both
 * PostgreSQL and SQLite — follows the context-injection-telemetry pattern).
 */
export async function initializeAgentBookSchema(pool: DatabasePool): Promise<void> {
  const dialect = pool.getDialect?.() ?? 'pg';

  if (dialect === 'sqlite') {
    await pool.query(SQLITE_EVENTS_DDL);
    await pool.query(SQLITE_SUMMARIES_DDL);
    await pool.query(SQLITE_CURRENT_STATE_DDL);
    await pool.query(SQLITE_RULES_DDL);
  } else {
    await pool.query(PG_EVENTS_DDL);
    await pool.query(PG_SUMMARIES_DDL);
    await pool.query(PG_CURRENT_STATE_DDL);
    await pool.query(PG_RULES_DDL);
  }

  await pool.query('CREATE INDEX IF NOT EXISTS idx_agentbook_events_project ON agentbook_events(project_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_agentbook_events_session ON agentbook_events(session_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_agentbook_events_occurred ON agentbook_events(occurred_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_agentbook_events_type ON agentbook_events(event_type)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_agentbook_summaries_project ON agentbook_summaries(project_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_agentbook_summaries_created ON agentbook_summaries(created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_agentbook_rules_scope ON agentbook_rules(scope, active)');

  getLogger().info('AgentBook schema initialized');
}

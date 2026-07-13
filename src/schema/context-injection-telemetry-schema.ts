import type { DatabasePool } from '../types.js';
import { getLogger } from '../logger.js';

const PG_EVENTS_DDL = `
  CREATE TABLE IF NOT EXISTS context_injection_events (
    id              BIGSERIAL PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    project_id      TEXT,
    session_id      TEXT NOT NULL,
    injection_kind  TEXT NOT NULL CHECK (injection_kind IN ('reentry', 'onboarding', 'context_brief', 'advisory')),
    source_turn_id  TEXT,
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    environment     TEXT NOT NULL CHECK (environment IN ('production', 'fixture', 'benchmark')),
    status          TEXT NOT NULL CHECK (status IN ('injected', 'skipped', 'failed')),
    char_count      INT NOT NULL DEFAULT 0,
    estimated_tokens INT NOT NULL DEFAULT 0,
    trim_level      TEXT NOT NULL DEFAULT 'none' CHECK (trim_level IN ('none', 'soft', 'aggressive')),
    block_hash      TEXT,
    builder_version TEXT NOT NULL,
    config_hash     TEXT NOT NULL,
    error_code      TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}'
  )
`;

const PG_ITEMS_DDL = `
  CREATE TABLE IF NOT EXISTS context_injection_items (
    id                    BIGSERIAL PRIMARY KEY,
    injection_event_id    BIGINT NOT NULL REFERENCES context_injection_events(id) ON DELETE CASCADE,
    layer_name            TEXT NOT NULL,
    source_kind           TEXT NOT NULL CHECK (source_kind IN ('memory', 'document_section', 'derived_state')),
    source_id             TEXT NOT NULL,
    memory_id             BIGINT REFERENCES memories(id) ON DELETE SET NULL,
    position              INT NOT NULL,
    selection_rank        INT,
    selection_score       REAL,
    selection_reason_code TEXT CHECK (selection_reason_code IN (
      'importance_rank', 'recent_session', 'explicit_preference', 'active_goal',
      'budget_trim', 'layer_budget_exhausted', 'filter_rejection', 'empty_source'
    )),
    disposition           TEXT NOT NULL CHECK (disposition IN ('injected', 'trimmed', 'omitted')),
    provenance_granularity TEXT NOT NULL CHECK (provenance_granularity IN ('item', 'layer')),
    char_count            INT NOT NULL DEFAULT 0,
    metadata              JSONB NOT NULL DEFAULT '{}',
    UNIQUE (injection_event_id, layer_name, position)
  )
`;

const SQLITE_EVENTS_DDL = `
  CREATE TABLE IF NOT EXISTS context_injection_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    project_id      TEXT,
    session_id      TEXT NOT NULL,
    injection_kind  TEXT NOT NULL CHECK (injection_kind IN ('reentry', 'onboarding', 'context_brief', 'advisory')),
    source_turn_id  TEXT,
    recorded_at     TEXT NOT NULL DEFAULT (datetime('now')),
    environment     TEXT NOT NULL CHECK (environment IN ('production', 'fixture', 'benchmark')),
    status          TEXT NOT NULL CHECK (status IN ('injected', 'skipped', 'failed')),
    char_count      INTEGER NOT NULL DEFAULT 0,
    estimated_tokens INTEGER NOT NULL DEFAULT 0,
    trim_level      TEXT NOT NULL DEFAULT 'none' CHECK (trim_level IN ('none', 'soft', 'aggressive')),
    block_hash      TEXT,
    builder_version TEXT NOT NULL,
    config_hash     TEXT NOT NULL,
    error_code      TEXT,
    metadata        TEXT NOT NULL DEFAULT '{}'
  )
`;

const SQLITE_ITEMS_DDL = `
  CREATE TABLE IF NOT EXISTS context_injection_items (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    injection_event_id    INTEGER NOT NULL REFERENCES context_injection_events(id) ON DELETE CASCADE,
    layer_name            TEXT NOT NULL,
    source_kind           TEXT NOT NULL CHECK (source_kind IN ('memory', 'document_section', 'derived_state')),
    source_id             TEXT NOT NULL,
    memory_id             INTEGER REFERENCES memories(id) ON DELETE SET NULL,
    position              INTEGER NOT NULL,
    selection_rank        INTEGER,
    selection_score       REAL,
    selection_reason_code TEXT CHECK (selection_reason_code IN (
      'importance_rank', 'recent_session', 'explicit_preference', 'active_goal',
      'budget_trim', 'layer_budget_exhausted', 'filter_rejection', 'empty_source'
    )),
    disposition           TEXT NOT NULL CHECK (disposition IN ('injected', 'trimmed', 'omitted')),
    provenance_granularity TEXT NOT NULL CHECK (provenance_granularity IN ('item', 'layer')),
    char_count            INTEGER NOT NULL DEFAULT 0,
    metadata              TEXT NOT NULL DEFAULT '{}',
    UNIQUE (injection_event_id, layer_name, position)
  )
`;

export async function initializeContextInjectionTelemetrySchema(pool: DatabasePool): Promise<void> {
  const dialect = pool.getDialect?.() ?? 'pg';

  if (dialect === 'sqlite') {
    await pool.query(SQLITE_EVENTS_DDL);
    await pool.query(SQLITE_ITEMS_DDL);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ctx_inj_events_session ON context_injection_events(session_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ctx_inj_events_recorded ON context_injection_events(recorded_at DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ctx_inj_events_kind ON context_injection_events(injection_kind)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ctx_inj_items_event ON context_injection_items(injection_event_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ctx_inj_items_layer ON context_injection_items(layer_name)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ctx_inj_items_memory ON context_injection_items(memory_id) WHERE memory_id IS NOT NULL');
  } else {
    await pool.query(PG_EVENTS_DDL);
    await pool.query(PG_ITEMS_DDL);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ctx_inj_events_session ON context_injection_events(session_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ctx_inj_events_recorded ON context_injection_events(recorded_at DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ctx_inj_events_kind ON context_injection_events(injection_kind)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ctx_inj_items_event ON context_injection_items(injection_event_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ctx_inj_items_layer ON context_injection_items(layer_name)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ctx_inj_items_memory ON context_injection_items(memory_id) WHERE memory_id IS NOT NULL');
  }

  getLogger().info('Context injection telemetry schema initialized');
}

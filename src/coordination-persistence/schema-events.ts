import type { DatabasePool } from '../types.js';

const EVENTS_SQL = `
  CREATE TABLE IF NOT EXISTS coordination_events (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES coordination_workspaces(id) ON DELETE RESTRICT,
    assignment_id TEXT,
    actor_agent_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (length(btrim(type)) > 0),
    payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    sequence BIGINT NOT NULL CHECK (sequence >= 1),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, sequence),
    FOREIGN KEY (workspace_id, assignment_id)
      REFERENCES coordination_assignments(workspace_id, id) ON DELETE RESTRICT DEFERRABLE,
    FOREIGN KEY (workspace_id, actor_agent_id)
      REFERENCES coordination_agents(workspace_id, id) ON DELETE RESTRICT DEFERRABLE
  )`;

const IDEMPOTENCY_SQL = `
  CREATE TABLE IF NOT EXISTS coordination_idempotency_keys (
    workspace_id TEXT NOT NULL REFERENCES coordination_workspaces(id) ON DELETE RESTRICT,
    idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) > 0),
    operation TEXT NOT NULL CHECK (length(btrim(operation)) > 0),
    request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, idempotency_key)
  )`;

const APPEND_ONLY_SQL = `
  CREATE OR REPLACE FUNCTION coordination_reject_event_mutation()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'coordination events are append-only';
  END $$`;

const SEQUENCE_GUARD_SQL = `
  CREATE OR REPLACE FUNCTION coordination_guard_event_sequence()
  RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE expected BIGINT;
  BEGIN
    SELECT event_sequence INTO expected FROM coordination_workspaces WHERE id = NEW.workspace_id;
    IF expected IS NULL OR NEW.sequence <> expected THEN
      RAISE EXCEPTION 'coordination event sequence does not match workspace counter';
    END IF;
    RETURN NEW;
  END $$`;

const APPEND_ONLY_TRIGGER_SQL = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_coordination_events_append_only') THEN
      CREATE TRIGGER trg_coordination_events_append_only
        BEFORE UPDATE OR DELETE ON coordination_events FOR EACH ROW
        EXECUTE FUNCTION coordination_reject_event_mutation();
    END IF;
  END $$`;

const SEQUENCE_TRIGGER_SQL = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_coordination_event_sequence') THEN
      CREATE TRIGGER trg_coordination_event_sequence
        BEFORE INSERT ON coordination_events FOR EACH ROW
        EXECUTE FUNCTION coordination_guard_event_sequence();
    END IF;
  END $$`;

export async function initializeCoordinationEventSchema(pool: DatabasePool): Promise<void> {
  await pool.query(EVENTS_SQL);
  await pool.query(IDEMPOTENCY_SQL);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_coordination_events_assignment ON coordination_events(workspace_id, assignment_id, sequence)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_coordination_idempotency_created ON coordination_idempotency_keys(workspace_id, created_at)');
  await pool.query(APPEND_ONLY_SQL);
  await pool.query(SEQUENCE_GUARD_SQL);
  await pool.query(APPEND_ONLY_TRIGGER_SQL);
  await pool.query(SEQUENCE_TRIGGER_SQL);
}

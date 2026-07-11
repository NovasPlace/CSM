import type { DatabasePool } from '../types.js';

const WORKSPACES_SQL = `
  CREATE TABLE IF NOT EXISTS coordination_workspaces (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    title TEXT NOT NULL CHECK (length(btrim(title)) > 0),
    objective TEXT NOT NULL CHECK (length(btrim(objective)) > 0),
    primary_agent_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('planned','active','paused','completed','cancelled')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    event_sequence BIGINT NOT NULL DEFAULT 0 CHECK (event_sequence >= 0),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    UNIQUE (id, primary_agent_id)
  )`;

const AGENTS_SQL = `
  CREATE TABLE IF NOT EXISTS coordination_agents (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES coordination_workspaces(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN (
      'primary','research','implementation','review','security','verification','specialist'
    )),
    status TEXT NOT NULL CHECK (status IN (
      'idle','assigned','working','blocked','awaiting_review','complete','offline'
    )),
    capabilities JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(capabilities) = 'array'),
    active_assignment_id TEXT,
    last_heartbeat_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, id)
  )`;

const PRIMARY_FK_SQL = `
  DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'fk_coordination_workspace_primary_agent'
    ) THEN
      ALTER TABLE coordination_workspaces
        ADD CONSTRAINT fk_coordination_workspace_primary_agent
        FOREIGN KEY (id, primary_agent_id)
        REFERENCES coordination_agents(workspace_id, id)
        DEFERRABLE INITIALLY DEFERRED;
    END IF;
  END $$`;

const PRIMARY_ROLE_SQL = `
  CREATE OR REPLACE FUNCTION coordination_validate_primary_agent()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM coordination_agents
      WHERE workspace_id = NEW.id AND id = NEW.primary_agent_id AND role = 'primary'
    ) THEN
      RAISE EXCEPTION 'workspace primary_agent_id must reference its primary agent';
    END IF;
    RETURN NEW;
  END $$`;

const PRIMARY_ROLE_TRIGGER_SQL = `
  DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = 'trg_coordination_primary_agent_role'
    ) THEN
      CREATE CONSTRAINT TRIGGER trg_coordination_primary_agent_role
        AFTER INSERT OR UPDATE OF primary_agent_id ON coordination_workspaces
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION coordination_validate_primary_agent();
    END IF;
  END $$`;

const AGENT_PRIMARY_ROLE_SQL = `
  CREATE OR REPLACE FUNCTION coordination_validate_agent_primary_role()
  RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE target_workspace TEXT; target_agent TEXT;
  BEGIN
    target_workspace := CASE WHEN TG_OP = 'DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
    target_agent := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
    IF EXISTS (
      SELECT 1 FROM coordination_workspaces w
      WHERE w.id = target_workspace AND w.primary_agent_id = target_agent
    ) AND NOT EXISTS (
      SELECT 1 FROM coordination_agents a
      WHERE a.workspace_id = target_workspace AND a.id = target_agent AND a.role = 'primary'
    ) THEN
      RAISE EXCEPTION 'workspace primary agent must retain the primary role';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END $$`;

const AGENT_PRIMARY_TRIGGER_SQL = `
  DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = 'trg_coordination_agent_primary_role'
    ) THEN
      CREATE CONSTRAINT TRIGGER trg_coordination_agent_primary_role
        AFTER INSERT OR UPDATE OR DELETE ON coordination_agents
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION coordination_validate_agent_primary_role();
    END IF;
  END $$`;

export async function initializeCoordinationWorkspaceSchema(pool: DatabasePool): Promise<void> {
  await pool.query(WORKSPACES_SQL);
  await pool.query(AGENTS_SQL);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_coordination_primary_agent
    ON coordination_agents(workspace_id) WHERE role = 'primary'`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_coordination_agents_status ON coordination_agents(workspace_id, status)');
  await pool.query(PRIMARY_FK_SQL);
  await pool.query(PRIMARY_ROLE_SQL);
  await pool.query(PRIMARY_ROLE_TRIGGER_SQL);
  await pool.query(AGENT_PRIMARY_ROLE_SQL);
  await pool.query(AGENT_PRIMARY_TRIGGER_SQL);
}

import type { DatabasePool } from '../types.js';

const CLAIMS_SQL = `
  CREATE TABLE IF NOT EXISTS coordination_resource_claims (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    assignment_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    resource_type TEXT NOT NULL CHECK (resource_type IN (
      'file','file_region','database_schema','database_table','service','configuration','external_resource'
    )),
    resource_id TEXT NOT NULL CHECK (length(btrim(resource_id)) > 0),
    has_region BOOLEAN NOT NULL,
    start_line INTEGER CHECK (start_line IS NULL OR start_line >= 1),
    end_line INTEGER CHECK (end_line IS NULL OR end_line >= 1),
    mode TEXT NOT NULL CHECK (mode IN ('read','write','exclusive')),
    status TEXT NOT NULL CHECK (status IN ('active','released','expired','conflicted')),
    lease_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at TIMESTAMPTZ,
    CHECK (has_region OR (start_line IS NULL AND end_line IS NULL)),
    CHECK (resource_type <> 'file_region' OR has_region),
    CHECK (start_line IS NULL OR end_line IS NULL OR start_line <= end_line),
    UNIQUE (workspace_id, id),
    FOREIGN KEY (workspace_id, assignment_id)
      REFERENCES coordination_assignments(workspace_id, id) ON DELETE RESTRICT DEFERRABLE,
    FOREIGN KEY (workspace_id, agent_id)
      REFERENCES coordination_agents(workspace_id, id) ON DELETE RESTRICT DEFERRABLE
  )`;

const CLAIM_GUARD_SQL = `
  CREATE OR REPLACE FUNCTION coordination_guard_resource_claim()
  RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE family TEXT;
  BEGIN
    IF NEW.status <> 'active' THEN RETURN NEW; END IF;
    family := CASE WHEN NEW.resource_type = 'file_region' THEN 'file' ELSE NEW.resource_type END;
    PERFORM pg_advisory_xact_lock(hashtextextended(
      NEW.workspace_id || ':' || family || ':' || NEW.resource_id, 0));
    IF EXISTS (
      SELECT 1 FROM coordination_resource_claims c
      WHERE c.workspace_id = NEW.workspace_id AND c.id <> NEW.id
        AND (CASE WHEN c.resource_type = 'file_region' THEN 'file' ELSE c.resource_type END) = family
        AND c.resource_id = NEW.resource_id AND c.status = 'active'
        AND (c.lease_expires_at IS NULL OR c.lease_expires_at > now())
        AND COALESCE(c.start_line, 1) <= COALESCE(NEW.end_line, 2147483647)
        AND COALESCE(NEW.start_line, 1) <= COALESCE(c.end_line, 2147483647)
        AND (c.mode = 'exclusive' OR NEW.mode = 'exclusive'
          OR (c.mode = 'write' AND NEW.mode = 'write'))
    ) THEN
      RAISE EXCEPTION 'resource conflicts with an active coordination claim';
    END IF;
    RETURN NEW;
  END $$`;

const CLAIM_TRIGGER_SQL = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_coordination_claim_guard') THEN
      CREATE TRIGGER trg_coordination_claim_guard
        BEFORE INSERT OR UPDATE OF resource_type, resource_id, start_line, end_line, mode, status
        ON coordination_resource_claims FOR EACH ROW
        EXECUTE FUNCTION coordination_guard_resource_claim();
    END IF;
  END $$`;

export async function initializeCoordinationClaimSchema(pool: DatabasePool): Promise<void> {
  await pool.query(CLAIMS_SQL);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_coordination_claims_active
    ON coordination_resource_claims(workspace_id, resource_type, resource_id)
    WHERE status = 'active'`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_coordination_claims_assignment ON coordination_resource_claims(workspace_id, assignment_id)');
  await pool.query(CLAIM_GUARD_SQL);
  await pool.query(CLAIM_TRIGGER_SQL);
}

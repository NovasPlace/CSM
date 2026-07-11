import type { DatabasePool } from '../types.js';

const ASSIGNMENTS_SQL = `
  CREATE TABLE IF NOT EXISTS coordination_assignments (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES coordination_workspaces(id) ON DELETE CASCADE,
    parent_assignment_id TEXT,
    assigned_agent_id TEXT,
    title TEXT NOT NULL CHECK (length(btrim(title)) > 0),
    objective TEXT NOT NULL CHECK (length(btrim(objective)) > 0),
    instructions TEXT NOT NULL CHECK (length(btrim(instructions)) > 0),
    status TEXT NOT NULL CHECK (status IN (
      'queued','ready','assigned','active','blocked','review','verified','completed','failed','cancelled'
    )),
    priority INTEGER NOT NULL CHECK (priority >= 0),
    risk TEXT NOT NULL CHECK (risk IN ('low','medium','high','critical')),
    allowed_resources JSONB NOT NULL CHECK (jsonb_typeof(allowed_resources) = 'array'),
    required_deliverables JSONB NOT NULL CHECK (jsonb_typeof(required_deliverables) = 'array'),
    completion_criteria JSONB NOT NULL CHECK (jsonb_typeof(completion_criteria) = 'array'),
    requires_verification BOOLEAN NOT NULL,
    requires_user_approval BOOLEAN NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    UNIQUE (workspace_id, id),
    FOREIGN KEY (workspace_id, parent_assignment_id)
      REFERENCES coordination_assignments(workspace_id, id) ON DELETE RESTRICT DEFERRABLE,
    FOREIGN KEY (workspace_id, assigned_agent_id)
      REFERENCES coordination_agents(workspace_id, id) ON DELETE RESTRICT DEFERRABLE
  )`;

const DEPENDENCIES_SQL = `
  CREATE TABLE IF NOT EXISTS coordination_dependencies (
    workspace_id TEXT NOT NULL,
    assignment_id TEXT NOT NULL,
    depends_on_assignment_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, assignment_id, depends_on_assignment_id),
    CHECK (assignment_id <> depends_on_assignment_id),
    FOREIGN KEY (workspace_id, assignment_id)
      REFERENCES coordination_assignments(workspace_id, id) ON DELETE CASCADE DEFERRABLE,
    FOREIGN KEY (workspace_id, depends_on_assignment_id)
      REFERENCES coordination_assignments(workspace_id, id) ON DELETE RESTRICT DEFERRABLE
  )`;

const ACTIVE_ASSIGNMENT_FK_SQL = `
  DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'fk_coordination_agent_active_assignment'
    ) THEN
      ALTER TABLE coordination_agents
        ADD CONSTRAINT fk_coordination_agent_active_assignment
        FOREIGN KEY (workspace_id, active_assignment_id)
        REFERENCES coordination_assignments(workspace_id, id)
        ON DELETE RESTRICT DEFERRABLE;
    END IF;
  END $$`;

export async function initializeCoordinationAssignmentSchema(pool: DatabasePool): Promise<void> {
  await pool.query(ASSIGNMENTS_SQL);
  await pool.query(DEPENDENCIES_SQL);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_coordination_assignments_status ON coordination_assignments(workspace_id, status, priority DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_coordination_assignments_agent ON coordination_assignments(workspace_id, assigned_agent_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_coordination_dependencies_target ON coordination_dependencies(workspace_id, depends_on_assignment_id)');
  await pool.query(ACTIVE_ASSIGNMENT_FK_SQL);
}

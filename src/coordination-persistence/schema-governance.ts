import type { DatabasePool } from '../types.js';

const APPROVALS_SQL = `
  CREATE TABLE IF NOT EXISTS coordination_approvals (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    assignment_id TEXT,
    requested_by_agent_id TEXT NOT NULL,
    action_type TEXT NOT NULL CHECK (length(btrim(action_type)) > 0),
    risk TEXT NOT NULL CHECK (risk IN ('medium','high','critical')),
    action_preview JSONB NOT NULL,
    rationale TEXT NOT NULL CHECK (length(btrim(rationale)) > 0),
    status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired','revoked')),
    expires_at TIMESTAMPTZ,
    decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, id),
    FOREIGN KEY (workspace_id, assignment_id)
      REFERENCES coordination_assignments(workspace_id, id) ON DELETE RESTRICT DEFERRABLE,
    FOREIGN KEY (workspace_id, requested_by_agent_id)
      REFERENCES coordination_agents(workspace_id, id) ON DELETE RESTRICT DEFERRABLE
  )`;

const VERIFICATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS coordination_verifications (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    assignment_id TEXT NOT NULL,
    criterion_id TEXT NOT NULL CHECK (length(btrim(criterion_id)) > 0),
    status TEXT NOT NULL CHECK (status IN ('pending','passed','failed','waived')),
    evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'array'),
    verified_by_agent_id TEXT NOT NULL,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, id),
    UNIQUE (workspace_id, assignment_id, criterion_id),
    CHECK (status <> 'passed' OR (verified_at IS NOT NULL AND jsonb_array_length(evidence) > 0)),
    FOREIGN KEY (workspace_id, assignment_id)
      REFERENCES coordination_assignments(workspace_id, id) ON DELETE RESTRICT DEFERRABLE,
    FOREIGN KEY (workspace_id, verified_by_agent_id)
      REFERENCES coordination_agents(workspace_id, id) ON DELETE RESTRICT DEFERRABLE
  )`;

export async function initializeCoordinationGovernanceSchema(pool: DatabasePool): Promise<void> {
  await pool.query(APPROVALS_SQL);
  await pool.query(VERIFICATIONS_SQL);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_coordination_approvals_pending ON coordination_approvals(workspace_id, status, expires_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_coordination_verifications_assignment ON coordination_verifications(workspace_id, assignment_id)');
}

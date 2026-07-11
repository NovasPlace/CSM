import type { DatabasePool } from '../types.js';

const FINDINGS_SQL = `
  CREATE TABLE IF NOT EXISTS coordination_findings (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    assignment_id TEXT NOT NULL,
    created_by_agent_id TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')),
    summary TEXT NOT NULL CHECK (length(btrim(summary)) > 0),
    evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'array'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, id),
    FOREIGN KEY (workspace_id, assignment_id)
      REFERENCES coordination_assignments(workspace_id, id) ON DELETE RESTRICT DEFERRABLE,
    FOREIGN KEY (workspace_id, created_by_agent_id)
      REFERENCES coordination_agents(workspace_id, id) ON DELETE RESTRICT DEFERRABLE
  )`;

const DELIVERABLES_SQL = `
  CREATE TABLE IF NOT EXISTS coordination_deliverables (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    assignment_id TEXT NOT NULL,
    submitted_by_agent_id TEXT NOT NULL,
    contract_id TEXT NOT NULL CHECK (length(btrim(contract_id)) > 0),
    reference TEXT NOT NULL CHECK (length(btrim(reference)) > 0),
    summary TEXT NOT NULL CHECK (length(btrim(summary)) > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, id),
    FOREIGN KEY (workspace_id, assignment_id)
      REFERENCES coordination_assignments(workspace_id, id) ON DELETE RESTRICT DEFERRABLE,
    FOREIGN KEY (workspace_id, submitted_by_agent_id)
      REFERENCES coordination_agents(workspace_id, id) ON DELETE RESTRICT DEFERRABLE
  )`;

const HANDOFFS_SQL = `
  CREATE TABLE IF NOT EXISTS coordination_handoffs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    assignment_id TEXT NOT NULL,
    from_agent_id TEXT NOT NULL,
    to_agent_id TEXT NOT NULL,
    summary TEXT NOT NULL CHECK (length(btrim(summary)) > 0),
    findings JSONB NOT NULL CHECK (jsonb_typeof(findings) = 'array'),
    deliverables JSONB NOT NULL CHECK (jsonb_typeof(deliverables) = 'array'),
    changed_resources JSONB NOT NULL CHECK (jsonb_typeof(changed_resources) = 'array'),
    unresolved_questions JSONB NOT NULL CHECK (jsonb_typeof(unresolved_questions) = 'array'),
    risks JSONB NOT NULL CHECK (jsonb_typeof(risks) = 'array'),
    evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'array'),
    verification_results JSONB NOT NULL CHECK (jsonb_typeof(verification_results) = 'array'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, id),
    FOREIGN KEY (workspace_id, assignment_id)
      REFERENCES coordination_assignments(workspace_id, id) ON DELETE RESTRICT DEFERRABLE,
    FOREIGN KEY (workspace_id, from_agent_id)
      REFERENCES coordination_agents(workspace_id, id) ON DELETE RESTRICT DEFERRABLE,
    FOREIGN KEY (workspace_id, to_agent_id)
      REFERENCES coordination_agents(workspace_id, id) ON DELETE RESTRICT DEFERRABLE
  )`;

export async function initializeCoordinationArtifactSchema(pool: DatabasePool): Promise<void> {
  await pool.query(FINDINGS_SQL);
  await pool.query(DELIVERABLES_SQL);
  await pool.query(HANDOFFS_SQL);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_coordination_findings_assignment ON coordination_findings(workspace_id, assignment_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_coordination_deliverables_assignment ON coordination_deliverables(workspace_id, assignment_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_coordination_handoffs_assignment ON coordination_handoffs(workspace_id, assignment_id, created_at)');
}

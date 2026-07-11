import { CoordinationDomainError } from '../coordination/errors.js';
import { validateAssignment } from '../coordination/validators.js';
import type { CoordinationAssignment } from '../coordination/types.js';
import type { DatabaseClient, DatabasePool } from '../types.js';
import { appendCoordinationEvent } from './event-writer.js';
import { readReplay, writeReplay } from './idempotency.js';
import { jsonParameter, requestHash } from './json.js';
import { assertVersion, lockWorkspace, requirePrimaryActor } from './locks.js';
import { withCoordinationTransaction } from './transaction.js';
import type { CreateAssignmentRequest, MutationResult } from './types.js';
import { incrementWorkspace } from './workspace-operations.js';

export function createAssignment(
  pool: DatabasePool,
  request: CreateAssignmentRequest,
): Promise<MutationResult> {
  const assignment = validateAssignment(request.assignment);
  if (assignment.version !== 1) throw new TypeError('New assignments must start at version 1');
  const dependencies = validateDependencyIds(request.dependencyIds, assignment.id);
  const payload = assignmentPayload(assignment);
  const hash = requestHash({ assignment: payload, dependencyIds: dependencies,
    actorAgentId: request.actorAgentId, expectedWorkspaceVersion: request.expectedWorkspaceVersion });
  return withCoordinationTransaction(pool, async (client) => {
    const replay = await readReplay<MutationResult>(client, assignment.workspaceId, request.idempotencyKey, 'create_assignment', hash);
    if (replay) return { ...replay, replayed: true };
    const workspace = await lockWorkspace(client, assignment.workspaceId);
    await requirePrimaryActor(client, workspace, request.actorAgentId);
    assertVersion(workspace.version, request.expectedWorkspaceVersion);
    await assertDependenciesExist(client, assignment.workspaceId, dependencies);
    assertInitialStatus(assignment, dependencies);
    await insertAssignment(client, assignment);
    await insertDependencies(client, assignment.workspaceId, assignment.id, dependencies);
    const version = await incrementWorkspace(client, workspace.id);
    await appendCoordinationEvent(client, workspace.id, assignment.id, request.actorAgentId, 'assignment.created', {
      assignment: payload, dependencyIds: dependencies, workspaceVersion: version,
    });
    const result = { workspaceId: workspace.id, workspaceVersion: version,
      assignmentId: assignment.id, assignmentVersion: assignment.version, replayed: false };
    await writeReplay(client, workspace.id, request.idempotencyKey, 'create_assignment', hash, result);
    return result;
  });
}

async function insertAssignment(client: DatabaseClient, row: CoordinationAssignment): Promise<void> {
  const payload = assignmentPayload(row);
  await client.query(
    `INSERT INTO coordination_assignments
      (id, workspace_id, parent_assignment_id, assigned_agent_id, title, objective, instructions,
       status, priority, risk, allowed_resources, required_deliverables, completion_criteria,
       requires_verification, requires_user_approval, version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,$16)`,
    [row.id, row.workspaceId, row.parentAssignmentId, row.assignedAgentId, row.title,
      row.objective, row.instructions, row.status, row.priority, row.risk,
      jsonParameter(payload.allowedResources, 'allowed resources'),
      jsonParameter(row.requiredDeliverables, 'required deliverables'),
      jsonParameter(row.completionCriteria, 'completion criteria'),
      row.requiresVerification, row.requiresUserApproval, row.version],
  );
}

async function insertDependencies(
  client: DatabaseClient,
  workspaceId: string,
  assignmentId: string,
  dependencies: readonly string[],
): Promise<void> {
  for (const dependencyId of dependencies) {
    await client.query(
      `INSERT INTO coordination_dependencies
        (workspace_id, assignment_id, depends_on_assignment_id) VALUES ($1,$2,$3)`,
      [workspaceId, assignmentId, dependencyId],
    );
  }
}

async function assertDependenciesExist(
  client: DatabaseClient,
  workspaceId: string,
  dependencies: readonly string[],
): Promise<void> {
  if (dependencies.length === 0) return;
  const result = await client.query(
    'SELECT id FROM coordination_assignments WHERE workspace_id = $1 AND id = ANY($2::text[])',
    [workspaceId, dependencies],
  );
  if (result.rows.length !== dependencies.length) {
    throw new CoordinationDomainError('ASSIGNMENT_DEPENDENCY_UNRESOLVED', 'A dependency is missing or belongs to another workspace');
  }
}

function validateDependencyIds(values: readonly string[], assignmentId: string): string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || value.trim() === '')) {
    throw new TypeError('dependencyIds must contain non-empty strings');
  }
  const unique = [...new Set(values)];
  if (unique.length !== values.length || unique.includes(assignmentId)) {
    throw new CoordinationDomainError('ASSIGNMENT_DEPENDENCY_UNRESOLVED', 'Dependencies must be unique and cannot reference the assignment itself');
  }
  return unique;
}

function assertInitialStatus(assignment: CoordinationAssignment, dependencies: readonly string[]): void {
  if (assignment.requiresUserApproval && assignment.risk === 'low') {
    throw new TypeError('User-approved assignments must have medium, high, or critical risk');
  }
  const expected = dependencies.length === 0 ? 'ready' : 'queued';
  if (assignment.status !== expected) {
    throw new CoordinationDomainError('INVALID_STATE_TRANSITION', `New assignment with this dependency set must start ${expected}`);
  }
}

function assignmentPayload(assignment: CoordinationAssignment): Record<string, unknown> {
  const allowedResources = assignment.allowedResources.map((scope) => ({
    ...scope,
    region: scope.region === null ? null : {
      ...(scope.region.startLine === undefined ? {} : { startLine: scope.region.startLine }),
      ...(scope.region.endLine === undefined ? {} : { endLine: scope.region.endLine }),
    },
  }));
  return { ...assignment, allowedResources };
}

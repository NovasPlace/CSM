import { CoordinationDomainError } from '../coordination/errors.js';
import type { CoordinationAgent, CoordinationAssignment, CoordinationWorkspace } from '../coordination/types.js';
import type { DatabaseClient } from '../types.js';
import { CoordinationPersistenceError } from './errors.js';
import { mapAgent, mapAssignment, mapWorkspace } from './rows.js';

export async function lockWorkspace(
  client: DatabaseClient,
  workspaceId: string,
): Promise<CoordinationWorkspace> {
  const result = await client.query('SELECT * FROM coordination_workspaces WHERE id = $1 FOR UPDATE', [workspaceId]);
  if (result.rows.length === 0) notFound('workspace', workspaceId);
  return mapWorkspace(result.rows[0]);
}

export async function lockAssignment(
  client: DatabaseClient,
  workspaceId: string,
  assignmentId: string,
): Promise<CoordinationAssignment> {
  const result = await client.query(
    'SELECT * FROM coordination_assignments WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
    [workspaceId, assignmentId],
  );
  if (result.rows.length === 0) notFound('assignment', assignmentId);
  return mapAssignment(result.rows[0]);
}

export async function requirePrimaryActor(
  client: DatabaseClient,
  workspace: CoordinationWorkspace,
  actorId: string,
): Promise<CoordinationAgent> {
  const result = await client.query(
    'SELECT * FROM coordination_agents WHERE workspace_id = $1 AND id = $2',
    [workspace.id, actorId],
  );
  if (result.rows.length === 0) notFound('agent', actorId);
  const actor = mapAgent(result.rows[0]);
  if (actor.role !== 'primary' || workspace.primaryAgentId !== actor.id) {
    throw new CoordinationDomainError('ASSIGNMENT_SCOPE_VIOLATION', 'Only the workspace primary agent is authorized');
  }
  return actor;
}

export function assertVersion(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new CoordinationDomainError('VERSION_CONFLICT', 'Expected version does not match current version', {
      expectedVersion: expected, actualVersion: actual,
    });
  }
}

function notFound(kind: string, id: string): never {
  throw new CoordinationPersistenceError('NOT_FOUND', `Coordination ${kind} not found: ${id}`, { kind, id });
}

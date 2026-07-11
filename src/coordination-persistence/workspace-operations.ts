import { validateAgent, validatePrimaryAgentRoster, validateWorkspace } from '../coordination/validators.js';
import type { DatabaseClient, DatabasePool } from '../types.js';
import { appendCoordinationEvent } from './event-writer.js';
import { readReplay, writeReplay } from './idempotency.js';
import { jsonParameter, requestHash } from './json.js';
import { assertVersion, lockWorkspace, requirePrimaryActor } from './locks.js';
import { withCoordinationTransaction } from './transaction.js';
import type { CreateWorkspaceRequest, MutationResult, RegisterAgentRequest } from './types.js';

export function createWorkspace(
  pool: DatabasePool,
  request: CreateWorkspaceRequest,
): Promise<MutationResult> {
  const workspace = validateWorkspace(request.workspace);
  const agent = validateAgent(request.primaryAgent);
  validatePrimaryAgentRoster(workspace, [agent]);
  if (workspace.version !== 1 || workspace.completedAt !== null) {
    throw new TypeError('New workspaces must start at version 1 without a completion timestamp');
  }
  const hash = requestHash({ workspace, primaryAgent: agent });
  return withCoordinationTransaction(pool, async (client) => {
    const replay = await readReplay<MutationResult>(client, workspace.id, request.idempotencyKey, 'create_workspace', hash);
    if (replay) return { ...replay, replayed: true };
    await insertWorkspace(client, workspace);
    await insertAgent(client, agent);
    await appendCoordinationEvent(client, workspace.id, null, agent.id, 'workspace.created', {
      workspace, primaryAgent: agent,
    });
    const result = { workspaceId: workspace.id, workspaceVersion: workspace.version, replayed: false };
    await writeReplay(client, workspace.id, request.idempotencyKey, 'create_workspace', hash, result);
    return result;
  });
}

export function registerAgent(
  pool: DatabasePool,
  request: RegisterAgentRequest,
): Promise<MutationResult> {
  const agent = validateAgent(request.agent);
  const hash = requestHash({
    workspaceId: request.workspaceId, actorAgentId: request.actorAgentId,
    agent, expectedWorkspaceVersion: request.expectedWorkspaceVersion,
  });
  return withCoordinationTransaction(pool, async (client) => {
    const replay = await readReplay<MutationResult>(client, request.workspaceId, request.idempotencyKey, 'register_agent', hash);
    if (replay) return { ...replay, replayed: true };
    const workspace = await lockWorkspace(client, request.workspaceId);
    await requirePrimaryActor(client, workspace, request.actorAgentId);
    assertVersion(workspace.version, request.expectedWorkspaceVersion);
    if (agent.workspaceId !== workspace.id || agent.role === 'primary') throw new TypeError('Registered agent must be a non-primary member of the workspace');
    await insertAgent(client, agent);
    const version = await incrementWorkspace(client, workspace.id);
    await appendCoordinationEvent(client, workspace.id, null, request.actorAgentId, 'agent.registered', {
      agent, workspaceVersion: version,
    });
    const result = { workspaceId: workspace.id, workspaceVersion: version, replayed: false };
    await writeReplay(client, workspace.id, request.idempotencyKey, 'register_agent', hash, result);
    return result;
  });
}

async function insertWorkspace(client: DatabaseClient, workspace: ReturnType<typeof validateWorkspace>): Promise<void> {
  await client.query(
    `INSERT INTO coordination_workspaces
      (id, project_id, session_id, title, objective, primary_agent_id, status, version, created_at, updated_at, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [workspace.id, workspace.projectId, workspace.sessionId, workspace.title, workspace.objective,
      workspace.primaryAgentId, workspace.status, workspace.version, workspace.createdAt,
      workspace.updatedAt, workspace.completedAt],
  );
}

export async function insertAgent(client: DatabaseClient, agent: ReturnType<typeof validateAgent>): Promise<void> {
  await client.query(
    `INSERT INTO coordination_agents
      (id, workspace_id, role, status, capabilities, active_assignment_id, last_heartbeat_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
    [agent.id, agent.workspaceId, agent.role, agent.status,
      jsonParameter(agent.capabilities, 'agent capabilities'), agent.activeAssignmentId, agent.lastHeartbeatAt],
  );
}

export async function incrementWorkspace(client: DatabaseClient, workspaceId: string): Promise<number> {
  const result = await client.query(
    `UPDATE coordination_workspaces SET version = version + 1, updated_at = now()
     WHERE id = $1 RETURNING version`,
    [workspaceId],
  );
  return Number((result.rows[0] as { version: unknown }).version);
}

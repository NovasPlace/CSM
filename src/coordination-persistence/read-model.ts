import type { DatabaseClient, DatabasePool } from '../types.js';
import { CoordinationPersistenceError } from './errors.js';
import { mapAgent, mapAssignment, mapClaim, mapEvent, mapWorkspace } from './rows.js';
import { requireCoordinationPostgres, withCoordinationReadTransaction } from './transaction.js';
import type { WorkspaceReadModel, WorkspaceReadOptions } from './types.js';

const DEFAULT_LIMITS = { agents: 500, assignments: 500, claims: 1000, events: 1000 } as const;
interface ReadLimits { agents: number; assignments: number; claims: number; events: number }

export async function readWorkspace(
  pool: DatabasePool,
  workspaceId: string,
  options: WorkspaceReadOptions = {},
): Promise<WorkspaceReadModel> {
  const limits = {
    agents: limit(options.agentLimit, DEFAULT_LIMITS.agents),
    assignments: limit(options.assignmentLimit, DEFAULT_LIMITS.assignments),
    claims: limit(options.claimLimit, DEFAULT_LIMITS.claims),
    events: limit(options.eventLimit, DEFAULT_LIMITS.events),
  };
  return withCoordinationReadTransaction(pool, (client) => loadWorkspace(client, workspaceId, limits));
}

async function loadWorkspace(
  client: DatabaseClient,
  workspaceId: string,
  limits: ReadLimits,
): Promise<WorkspaceReadModel> {
  const workspaceResult = await client.query('SELECT * FROM coordination_workspaces WHERE id = $1', [workspaceId]);
  if (workspaceResult.rows.length === 0) {
    throw new CoordinationPersistenceError('NOT_FOUND', `Coordination workspace not found: ${workspaceId}`);
  }
  const agents = await client.query('SELECT * FROM coordination_agents WHERE workspace_id = $1 ORDER BY created_at, id LIMIT $2', [workspaceId, limits.agents + 1]);
  const assignments = await client.query('SELECT * FROM coordination_assignments WHERE workspace_id = $1 ORDER BY priority DESC, created_at, id LIMIT $2', [workspaceId, limits.assignments + 1]);
  const claims = await client.query('SELECT * FROM coordination_resource_claims WHERE workspace_id = $1 ORDER BY created_at, id LIMIT $2', [workspaceId, limits.claims + 1]);
  const events = await client.query('SELECT * FROM coordination_events WHERE workspace_id = $1 ORDER BY sequence LIMIT $2', [workspaceId, limits.events + 1]);
  return {
    workspace: mapWorkspace(workspaceResult.rows[0]),
    agents: agents.rows.slice(0, limits.agents).map(mapAgent),
    assignments: assignments.rows.slice(0, limits.assignments).map(mapAssignment),
    claims: claims.rows.slice(0, limits.claims).map(mapClaim),
    events: events.rows.slice(0, limits.events).map(mapEvent),
    pageInfo: { agentsHasMore: agents.rows.length > limits.agents,
      assignmentsHasMore: assignments.rows.length > limits.assignments,
      claimsHasMore: claims.rows.length > limits.claims, eventsHasMore: events.rows.length > limits.events },
  };
}

export async function listEvents(
  pool: DatabasePool,
  workspaceId: string,
  afterSequence = 0,
  requestedLimit = 1000,
): Promise<ReturnType<typeof mapEvent>[]> {
  requireCoordinationPostgres(pool);
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new TypeError('afterSequence must be a non-negative integer');
  const result = await pool.query(
    `SELECT * FROM coordination_events WHERE workspace_id = $1 AND sequence > $2
     ORDER BY sequence LIMIT $3`,
    [workspaceId, afterSequence, limit(requestedLimit, 1000)],
  );
  return result.rows.map(mapEvent);
}

function limit(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 1000) {
    throw new TypeError('Read limit must be an integer from 1 through 1000');
  }
  return selected;
}

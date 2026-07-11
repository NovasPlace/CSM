import { randomUUID } from 'node:crypto';
import type { CoordinationEvent } from '../coordination/types.js';
import { requireJsonObject } from '../coordination/schema-validation.js';
import type { DatabaseClient } from '../types.js';
import { jsonParameter } from './json.js';
import { mapEvent } from './rows.js';

export async function appendCoordinationEvent(
  client: DatabaseClient,
  workspaceId: string,
  assignmentId: string | null,
  actorAgentId: string,
  type: string,
  payload: unknown,
): Promise<CoordinationEvent> {
  const safePayload = requireJsonObject(payload, 'event payload');
  const sequence = await nextSequence(client, workspaceId);
  const result = await client.query(
    `INSERT INTO coordination_events
      (id, workspace_id, assignment_id, actor_agent_id, type, payload, sequence)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING *`,
    [randomUUID(), workspaceId, assignmentId, actorAgentId, type,
      jsonParameter(safePayload, 'event payload'), sequence],
  );
  return mapEvent(result.rows[0]);
}

async function nextSequence(client: DatabaseClient, workspaceId: string): Promise<number> {
  const result = await client.query(
    `UPDATE coordination_workspaces SET event_sequence = event_sequence + 1
     WHERE id = $1 RETURNING event_sequence`,
    [workspaceId],
  );
  if (result.rows.length === 0) throw new Error(`Coordination workspace not found: ${workspaceId}`);
  return Number((result.rows[0] as { event_sequence: unknown }).event_sequence);
}

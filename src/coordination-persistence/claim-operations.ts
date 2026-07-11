import { CoordinationDomainError } from '../coordination/errors.js';
import { assertResourceAllowed } from '../coordination/claim-manager.js';
import { validateClaim } from '../coordination/validators.js';
import type { DatabaseClient, DatabasePool } from '../types.js';
import { appendCoordinationEvent } from './event-writer.js';
import { readReplay, writeReplay } from './idempotency.js';
import { requestHash } from './json.js';
import { assertVersion, lockAssignment, lockWorkspace } from './locks.js';
import { withCoordinationTransaction } from './transaction.js';
import type { AcquireClaimRequest, MutationResult } from './types.js';
import { incrementWorkspace } from './workspace-operations.js';

export function acquireClaim(
  pool: DatabasePool,
  request: AcquireClaimRequest,
): Promise<MutationResult> {
  const claim = validateClaim(request.claim);
  const payload = claimPayload(claim);
  const hash = requestHash({ claim: payload, expectedAssignmentVersion: request.expectedAssignmentVersion });
  return withCoordinationTransaction(pool, async (client) => {
    const replay = await readReplay<MutationResult>(client, claim.workspaceId, request.idempotencyKey, 'acquire_claim', hash);
    if (replay) return { ...replay, replayed: true };
    const workspace = await lockWorkspace(client, claim.workspaceId);
    const assignment = await lockAssignment(client, workspace.id, claim.assignmentId);
    assertVersion(assignment.version, request.expectedAssignmentVersion);
    assertClaimOwner(assignment.assignedAgentId, claim.agentId, claim.status);
    assertResourceAllowed(claim, assignment.allowedResources);
    await insertClaim(client, claim);
    const assignmentVersion = await incrementAssignment(client, workspace.id, assignment.id);
    const workspaceVersion = await incrementWorkspace(client, workspace.id);
    await appendCoordinationEvent(client, workspace.id, assignment.id, claim.agentId, 'claim.acquired', {
      claim: payload, assignmentVersion, workspaceVersion,
    });
    const result = { workspaceId: workspace.id, workspaceVersion,
      assignmentId: assignment.id, assignmentVersion, replayed: false };
    await writeReplay(client, workspace.id, request.idempotencyKey, 'acquire_claim', hash, result);
    return result;
  });
}

async function insertClaim(client: DatabaseClient, claim: ReturnType<typeof validateClaim>): Promise<void> {
  await client.query(
    `INSERT INTO coordination_resource_claims
      (id, workspace_id, assignment_id, agent_id, resource_type, resource_id,
       has_region, start_line, end_line, mode, status, lease_expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [claim.id, claim.workspaceId, claim.assignmentId, claim.agentId,
      claim.resourceType, claim.resourceId, claim.region !== null, claim.region?.startLine ?? null,
      claim.region?.endLine ?? null, claim.mode, claim.status, claim.leaseExpiresAt],
  );
}

async function incrementAssignment(
  client: DatabaseClient,
  workspaceId: string,
  assignmentId: string,
): Promise<number> {
  const result = await client.query(
    `UPDATE coordination_assignments SET version = version + 1, updated_at = now()
     WHERE workspace_id = $1 AND id = $2 RETURNING version`,
    [workspaceId, assignmentId],
  );
  return Number((result.rows[0] as { version: unknown }).version);
}

function assertClaimOwner(assignedAgentId: string | null, agentId: string, status: string): void {
  if (assignedAgentId !== agentId || status !== 'active') {
    throw new CoordinationDomainError('ASSIGNMENT_SCOPE_VIOLATION', 'Only the assigned agent can acquire an active claim');
  }
}

function claimPayload(claim: ReturnType<typeof validateClaim>): Record<string, unknown> {
  const region = claim.region === null ? null : {
    ...(claim.region.startLine === undefined ? {} : { startLine: claim.region.startLine }),
    ...(claim.region.endLine === undefined ? {} : { endLine: claim.region.endLine }),
  };
  return { ...claim, region };
}

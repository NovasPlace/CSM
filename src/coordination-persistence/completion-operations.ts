import { CoordinationDomainError } from '../coordination/errors.js';
import { validateVerificationResult } from '../coordination/verification-service.js';
import type { CoordinationAssignment, VerificationResult } from '../coordination/types.js';
import type { DatabaseClient, DatabasePool } from '../types.js';
import { appendCoordinationEvent } from './event-writer.js';
import { resolveCompletionVerifications } from './completion-verification.js';
import { readReplay, writeReplay } from './idempotency.js';
import { jsonParameter, requestHash } from './json.js';
import { assertVersion, lockAssignment, lockWorkspace, requirePrimaryActor } from './locks.js';
import { withCoordinationTransaction } from './transaction.js';
import type { CompleteAssignmentRequest, MutationResult } from './types.js';
import { incrementWorkspace } from './workspace-operations.js';

export function completeAssignment(
  pool: DatabasePool,
  request: CompleteAssignmentRequest,
): Promise<MutationResult> {
  const results = request.verificationResults.map(validateVerificationResult);
  const hash = requestHash({ ...request, verificationResults: results, idempotencyKey: null });
  return withCoordinationTransaction(pool, async (client) => {
    const replay = await readReplay<MutationResult>(client, request.workspaceId, request.idempotencyKey, 'complete_assignment', hash);
    if (replay) return { ...replay, replayed: true };
    const workspace = await lockWorkspace(client, request.workspaceId);
    await requirePrimaryActor(client, workspace, request.actorAgentId);
    assertVersion(workspace.version, request.expectedWorkspaceVersion);
    const assignment = await lockAssignment(client, workspace.id, request.assignmentId);
    assertVersion(assignment.version, request.expectedAssignmentVersion);
    await assertCompletionAllowed(client, assignment);
    const effectiveResults = await resolveCompletionVerifications(
      client, assignment, request.actorAgentId, results,
    );
    const verifiedVersion = await markVerified(client, assignment);
    await appendVerificationEvent(client, assignment, request.actorAgentId, effectiveResults, verifiedVersion);
    const assignmentVersion = await markCompleted(client, workspace.id, assignment.id);
    const releasedClaimIds = await releaseClaims(client, workspace.id, assignment.id);
    const readyAssignments = await unlockDependents(client, workspace.id, assignment.id);
    const workspaceVersion = await incrementWorkspace(client, workspace.id);
    await appendCompletionEvents(client, assignment, request.actorAgentId, assignmentVersion,
      workspaceVersion, releasedClaimIds, readyAssignments);
    const result = { workspaceId: workspace.id, workspaceVersion,
      assignmentId: assignment.id, assignmentVersion, replayed: false };
    await writeReplay(client, workspace.id, request.idempotencyKey, 'complete_assignment', hash, result);
    return result;
  });
}

async function assertCompletionAllowed(
  client: DatabaseClient,
  assignment: CoordinationAssignment,
): Promise<void> {
  if (assignment.status !== 'review' && assignment.status !== 'verified') {
    throw new CoordinationDomainError('INVALID_STATE_TRANSITION', 'Only reviewed or verified assignments can complete');
  }
  if (!assignment.requiresUserApproval) return;
  const preview = jsonParameter({ workspaceId: assignment.workspaceId,
    assignmentId: assignment.id, assignmentVersion: assignment.version }, 'approval target');
  const approval = await client.query(
    `SELECT 1 FROM coordination_approvals WHERE workspace_id = $1 AND assignment_id = $2
     AND action_type = 'assignment.complete' AND risk = $3 AND action_preview @> $4::jsonb
     AND status = 'approved' AND decided_at IS NOT NULL
     AND (expires_at IS NULL OR expires_at > now()) LIMIT 1`,
    [assignment.workspaceId, assignment.id, assignment.risk, preview],
  );
  if (approval.rows.length === 0) {
    throw new CoordinationDomainError('APPROVAL_REQUIRED', 'Assignment requires a current user approval');
  }
}

async function markVerified(client: DatabaseClient, assignment: CoordinationAssignment): Promise<number> {
  if (assignment.status === 'verified') return assignment.version;
  const result = await client.query(
    `UPDATE coordination_assignments SET status = 'verified', version = version + 1, updated_at = now()
     WHERE workspace_id = $1 AND id = $2 RETURNING version`,
    [assignment.workspaceId, assignment.id],
  );
  return Number((result.rows[0] as { version: unknown }).version);
}

async function markCompleted(client: DatabaseClient, workspaceId: string, assignmentId: string): Promise<number> {
  const result = await client.query(
    `UPDATE coordination_assignments SET status = 'completed', version = version + 1,
       updated_at = now(), completed_at = now() WHERE workspace_id = $1 AND id = $2 RETURNING version`,
    [workspaceId, assignmentId],
  );
  return Number((result.rows[0] as { version: unknown }).version);
}

async function releaseClaims(client: DatabaseClient, workspaceId: string, assignmentId: string): Promise<string[]> {
  const result = await client.query(
    `UPDATE coordination_resource_claims SET status = 'released', released_at = now()
     WHERE workspace_id = $1 AND assignment_id = $2 AND status = 'active' RETURNING id`,
    [workspaceId, assignmentId],
  );
  return result.rows.map((row) => String((row as { id: unknown }).id));
}

interface ReadyAssignment { id: string; version: number }

async function unlockDependents(
  client: DatabaseClient,
  workspaceId: string,
  completedId: string,
): Promise<ReadyAssignment[]> {
  const result = await client.query(
    `UPDATE coordination_assignments candidate SET status = 'ready', version = version + 1, updated_at = now()
     WHERE candidate.workspace_id = $1 AND candidate.status = 'queued'
       AND EXISTS (SELECT 1 FROM coordination_dependencies hit
         WHERE hit.workspace_id = $1 AND hit.assignment_id = candidate.id AND hit.depends_on_assignment_id = $2)
       AND NOT EXISTS (SELECT 1 FROM coordination_dependencies pending
         JOIN coordination_assignments dependency ON dependency.workspace_id = pending.workspace_id
          AND dependency.id = pending.depends_on_assignment_id
         WHERE pending.workspace_id = $1 AND pending.assignment_id = candidate.id AND dependency.status <> 'completed')
     RETURNING candidate.id, candidate.version`,
    [workspaceId, completedId],
  );
  return result.rows.map((value) => {
    const row = value as { id: unknown; version: unknown };
    return { id: String(row.id), version: Number(row.version) };
  });
}

async function appendCompletionEvents(
  client: DatabaseClient,
  assignment: CoordinationAssignment,
  actorId: string,
  assignmentVersion: number,
  workspaceVersion: number,
  releasedClaimIds: readonly string[],
  readyAssignments: readonly ReadyAssignment[],
): Promise<void> {
  await appendCoordinationEvent(client, assignment.workspaceId, assignment.id, actorId, 'assignment.completed', {
    assignmentId: assignment.id, assignmentVersion, workspaceVersion,
    releasedClaimIds, readyAssignments,
  });
  for (const ready of readyAssignments) {
    await appendCoordinationEvent(client, assignment.workspaceId, ready.id, actorId, 'assignment.ready', {
      assignmentId: ready.id, assignmentVersion: ready.version,
      completedDependencyId: assignment.id,
    });
  }
}

async function appendVerificationEvent(
  client: DatabaseClient,
  assignment: CoordinationAssignment,
  actorId: string,
  results: readonly VerificationResult[],
  verifiedVersion: number,
): Promise<void> {
  const type = assignment.status === 'review' ? 'assignment.verified' : 'verification.recorded';
  await appendCoordinationEvent(client, assignment.workspaceId, assignment.id, actorId, type, {
    assignmentId: assignment.id, fromVersion: assignment.version,
    assignmentVersion: verifiedVersion, verificationResults: results,
  });
}

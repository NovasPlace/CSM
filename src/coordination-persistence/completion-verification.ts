import { CoordinationDomainError } from '../coordination/errors.js';
import { assertVerificationComplete, validateVerificationResult } from '../coordination/verification-service.js';
import type { CoordinationAssignment, VerificationResult } from '../coordination/types.js';
import type { DatabaseClient } from '../types.js';
import { jsonParameter, requestHash } from './json.js';

export async function resolveCompletionVerifications(
  client: DatabaseClient,
  assignment: CoordinationAssignment,
  actorId: string,
  supplied: readonly VerificationResult[],
): Promise<readonly VerificationResult[]> {
  if (assignment.status === 'review') {
    assertVerificationComplete(assignment, supplied);
    await insertVerifications(client, assignment, actorId, supplied);
    return supplied;
  }
  const existing = await loadVerifications(client, assignment);
  assertVerificationComplete(assignment, existing);
  if (supplied.length > 0 && !sameVerifications(supplied, existing)) {
    throw new CoordinationDomainError('VERIFICATION_REQUIRED', 'Supplied verification does not match durable evidence');
  }
  return existing;
}

async function insertVerifications(
  client: DatabaseClient,
  assignment: CoordinationAssignment,
  actorId: string,
  results: readonly VerificationResult[],
): Promise<void> {
  for (const result of results) {
    await client.query(
      `INSERT INTO coordination_verifications
        (id, workspace_id, assignment_id, criterion_id, status, evidence, verified_by_agent_id, verified_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
      [result.id, assignment.workspaceId, assignment.id, result.criterionId, result.status,
        jsonParameter(result.evidence, 'verification evidence'), actorId, result.verifiedAt],
    );
  }
}

async function loadVerifications(
  client: DatabaseClient,
  assignment: CoordinationAssignment,
): Promise<VerificationResult[]> {
  const result = await client.query(
    `SELECT id, criterion_id, status, evidence, verified_at
     FROM coordination_verifications WHERE workspace_id = $1 AND assignment_id = $2
     ORDER BY criterion_id, id`,
    [assignment.workspaceId, assignment.id],
  );
  return result.rows.map((value) => {
    const row = value as Record<string, unknown>;
    const verifiedAt = row.verified_at instanceof Date ? row.verified_at.toISOString() : row.verified_at;
    return validateVerificationResult({ id: row.id, criterionId: row.criterion_id,
      status: row.status, evidence: row.evidence, verifiedAt });
  });
}

function sameVerifications(
  supplied: readonly VerificationResult[],
  existing: readonly VerificationResult[],
): boolean {
  const order = (rows: readonly VerificationResult[]) => [...rows]
    .sort((left, right) => left.criterionId.localeCompare(right.criterionId) || left.id.localeCompare(right.id));
  return requestHash(order(supplied)) === requestHash(order(existing));
}

import { randomUUID } from 'node:crypto';
import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ResourceClaim, VerificationResult } from '../dist/coordination/types.js';
import { assignmentFor, createCoordinationDatabase, destroyCoordinationDatabase, seedWorkspace, type CoordinationTestDatabase } from './coordination-persistence-fixture.js';

let database: CoordinationTestDatabase;

before(async () => { database = await createCoordinationDatabase('review_findings'); });
after(async () => { await destroyCoordinationDatabase(database); });

it('round-trips an unbounded file-region claim without losing region presence', async () => {
  const fixture = await readyAssignment();
  const claim: ResourceClaim = { id: randomUUID(), workspaceId: fixture.workspace.id,
    assignmentId: fixture.assignment.id, agentId: fixture.primary.id, resourceType: 'file_region',
    resourceId: 'src/a.ts', region: {}, mode: 'write', status: 'active', leaseExpiresAt: null };
  await database.store.acquireClaim({ claim, expectedAssignmentVersion: 1, idempotencyKey: randomUUID() });
  const region = (await database.store.readWorkspace(fixture.workspace.id)).claims[0].region;
  assert.notEqual(region, null);
  assert.equal(region?.startLine, undefined);
  assert.equal(region?.endLine, undefined);
});

it('persists an assignment with an unbounded file-region scope', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  const assignment = assignmentFor(workspace.id, primary.id, randomUUID(), {
    allowedResources: [{ resourceType: 'file_region', resourceId: 'src/a.ts', region: {}, mode: 'write' }],
  });
  await database.store.createAssignment({ assignment, dependencyIds: [], actorAgentId: primary.id,
    expectedWorkspaceVersion: 1, idempotencyKey: randomUUID() });
  const stored = (await database.store.readWorkspace(workspace.id)).assignments[0];
  assert.notEqual(stored.allowedResources[0].region, null);
});

it('binds completion approval to action, risk, target, and assignment version', async () => {
  const fixture = await reviewedAssignment(true);
  await insertApproval(fixture, 'unrelated.action', fixture.assignment.risk, 1);
  await assert.rejects(complete(fixture), /current user approval/);
  await insertApproval(fixture, 'assignment.complete', fixture.assignment.risk, 1);
  const result = await complete(fixture);
  assert.equal(result.assignmentVersion, 3);
});

it('rejects an approval targeting a different assignment version', async () => {
  const fixture = await reviewedAssignment(true);
  await insertApproval(fixture, 'assignment.complete', fixture.assignment.risk, 99);
  await assert.rejects(complete(fixture), /current user approval/);
});

it('records enough ordered event data to reconstruct assignment state', async () => {
  const fixture = await reviewedAssignment();
  await complete(fixture);
  const events = await database.store.listEvents(fixture.workspace.id);
  const created = events.find((event) => event.type === 'assignment.created');
  const verified = events.find((event) => event.type === 'assignment.verified');
  const completed = events.find((event) => event.type === 'assignment.completed');
  assert.equal((created?.payload.assignment as { id?: string }).id, fixture.assignment.id);
  assert.equal(verified?.payload.assignmentVersion, 2);
  assert.equal(completed?.payload.assignmentVersion, 3);
  assert.deepEqual(completed?.payload.releasedClaimIds, []);
});

it('prevents the referenced primary agent from losing its primary role', async () => {
  const { primary } = await seedWorkspace(database);
  await assert.rejects(database.pool.query('UPDATE coordination_agents SET role = $1 WHERE id = $2', ['review', primary.id]), /retain the primary role/);
  const row = await database.pool.query('SELECT role FROM coordination_agents WHERE id = $1', [primary.id]);
  assert.equal(row.rows[0].role, 'primary');
});

it('completes an already-verified assignment from durable evidence without reinsertion', async () => {
  const { fixture, result } = await verifiedAssignment();
  const completed = await completeVerified(fixture, []);
  assert.equal(completed.assignmentVersion, 3);
  const rows = await database.pool.query('SELECT id FROM coordination_verifications WHERE assignment_id = $1', [fixture.assignment.id]);
  assert.deepEqual(rows.rows.map((row) => row.id), [result.id]);
});

it('accepts an exact durable-verification resubmission without duplicating it', async () => {
  const { fixture, result } = await verifiedAssignment();
  await completeVerified(fixture, [result]);
  const count = await database.pool.query('SELECT count(*)::int AS count FROM coordination_verifications WHERE assignment_id = $1', [fixture.assignment.id]);
  assert.equal(count.rows[0].count, 1);
});

async function readyAssignment(requiresUserApproval = false) {
  const { workspace, primary } = await seedWorkspace(database);
  const assignment = assignmentFor(workspace.id, primary.id, randomUUID(), { requiresUserApproval });
  await database.store.createAssignment({ assignment, dependencyIds: [], actorAgentId: primary.id,
    expectedWorkspaceVersion: 1, idempotencyKey: randomUUID() });
  return { workspace, primary, assignment };
}

async function reviewedAssignment(requiresUserApproval = false) {
  const fixture = await readyAssignment(requiresUserApproval);
  await database.pool.query(`UPDATE coordination_assignments SET status = 'review' WHERE id = $1`, [fixture.assignment.id]);
  return fixture;
}

function verification(): VerificationResult {
  return { id: randomUUID(), criterionId: 'tests', status: 'passed',
    evidence: [{ kind: 'command', reference: 'npm test', sha256: 'b'.repeat(64) }],
    verifiedAt: new Date().toISOString() };
}

async function verifiedAssignment() {
  const fixture = await readyAssignment();
  const result = verification();
  await database.pool.query(`UPDATE coordination_assignments SET status = 'verified', version = 2 WHERE id = $1`, [fixture.assignment.id]);
  await database.pool.query(
    `INSERT INTO coordination_verifications
      (id,workspace_id,assignment_id,criterion_id,status,evidence,verified_by_agent_id,verified_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
    [result.id, fixture.workspace.id, fixture.assignment.id, result.criterionId, result.status,
      JSON.stringify(result.evidence), fixture.primary.id, result.verifiedAt],
  );
  return { fixture, result };
}

function completeVerified(
  fixture: Awaited<ReturnType<typeof readyAssignment>>,
  verificationResults: VerificationResult[],
) {
  return database.store.completeAssignment({ workspaceId: fixture.workspace.id,
    assignmentId: fixture.assignment.id, actorAgentId: fixture.primary.id,
    expectedWorkspaceVersion: 2, expectedAssignmentVersion: 2,
    verificationResults, idempotencyKey: randomUUID() });
}

function complete(fixture: Awaited<ReturnType<typeof readyAssignment>>) {
  return database.store.completeAssignment({ workspaceId: fixture.workspace.id,
    assignmentId: fixture.assignment.id, actorAgentId: fixture.primary.id,
    expectedWorkspaceVersion: 2, expectedAssignmentVersion: 1,
    verificationResults: [verification()], idempotencyKey: randomUUID() });
}

async function insertApproval(
  fixture: Awaited<ReturnType<typeof readyAssignment>>,
  actionType: string,
  risk: string,
  assignmentVersion: number,
): Promise<void> {
  await database.pool.query(
    `INSERT INTO coordination_approvals
      (id, workspace_id, assignment_id, requested_by_agent_id, action_type, risk,
       action_preview, rationale, status, decided_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'approved',now())`,
    [randomUUID(), fixture.workspace.id, fixture.assignment.id, fixture.primary.id,
      actionType, risk, JSON.stringify({ workspaceId: fixture.workspace.id,
        assignmentId: fixture.assignment.id, assignmentVersion }), 'Exact user authorization'],
  );
}

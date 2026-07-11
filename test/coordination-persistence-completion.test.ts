import { randomUUID } from 'node:crypto';
import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ResourceClaim, VerificationResult } from '../dist/coordination/types.js';
import { assignmentFor, createCoordinationDatabase, destroyCoordinationDatabase, seedWorkspace, type CoordinationTestDatabase } from './coordination-persistence-fixture.js';

let database: CoordinationTestDatabase;

before(async () => { database = await createCoordinationDatabase('completion'); });
after(async () => { await destroyCoordinationDatabase(database); });

it('acquires an allowed active resource claim atomically', async () => {
  const fixture = await readyAssignment();
  const result = await database.store.acquireClaim({ claim: claimFor(fixture),
    expectedAssignmentVersion: 1, idempotencyKey: `claim-${fixture.assignment.id}` });
  assert.equal(result.assignmentVersion, 2);
  assert.equal((await database.store.readWorkspace(fixture.workspace.id)).claims.length, 1);
});

it('replays claim acquisition without another event or version increment', async () => {
  const fixture = await readyAssignment();
  const claim = claimFor(fixture);
  const request = { claim, expectedAssignmentVersion: 1, idempotencyKey: `claim-${claim.id}` };
  await database.store.acquireClaim(request);
  const replay = await database.store.acquireClaim(request);
  assert.equal(replay.replayed, true);
  assert.equal((await database.store.readWorkspace(fixture.workspace.id)).claims.length, 1);
});

it('rejects overlapping write claims under concurrent-safe database enforcement', async () => {
  const fixture = await readyAssignment();
  await database.store.acquireClaim({ claim: claimFor(fixture), expectedAssignmentVersion: 1, idempotencyKey: randomUUID() });
  await assert.rejects(database.store.acquireClaim({ claim: claimFor(fixture, { id: randomUUID() }),
    expectedAssignmentVersion: 2, idempotencyKey: randomUUID() }), /conflicts with an active/);
});

it('allows multiple overlapping read claims', async () => {
  const fixture = await readyAssignment();
  await database.store.acquireClaim({ claim: claimFor(fixture, { mode: 'read' }), expectedAssignmentVersion: 1, idempotencyKey: randomUUID() });
  await database.store.acquireClaim({ claim: claimFor(fixture, { id: randomUUID(), mode: 'read' }), expectedAssignmentVersion: 2, idempotencyKey: randomUUID() });
  assert.equal((await database.store.readWorkspace(fixture.workspace.id)).claims.length, 2);
});

it('allows non-overlapping write regions on one file', async () => {
  const fixture = await readyAssignment();
  await database.store.acquireClaim({ claim: claimFor(fixture, { resourceType: 'file_region', region: { startLine: 1, endLine: 10 } }),
    expectedAssignmentVersion: 1, idempotencyKey: randomUUID() });
  await database.store.acquireClaim({ claim: claimFor(fixture, { id: randomUUID(), resourceType: 'file_region', region: { startLine: 11, endLine: 20 } }),
    expectedAssignmentVersion: 2, idempotencyKey: randomUUID() });
  assert.equal((await database.store.readWorkspace(fixture.workspace.id)).claims.length, 2);
});

it('rolls back claims outside the assignment resource scope', async () => {
  const fixture = await readyAssignment();
  await assert.rejects(database.store.acquireClaim({ claim: claimFor(fixture, { resourceId: 'src/forbidden.ts' }),
    expectedAssignmentVersion: 1, idempotencyKey: randomUUID() }));
  assert.equal((await database.store.readWorkspace(fixture.workspace.id)).claims.length, 0);
});

it('rolls back a claim when the assignment version is stale', async () => {
  const fixture = await readyAssignment();
  await assert.rejects(database.store.acquireClaim({ claim: claimFor(fixture),
    expectedAssignmentVersion: 8, idempotencyKey: randomUUID() }));
  assert.equal((await database.store.readWorkspace(fixture.workspace.id)).claims.length, 0);
});

it('completes a reviewed assignment with evidenced verification', async () => {
  const fixture = await reviewedAssignment();
  const result = await complete(fixture, 2, 1);
  assert.equal(result.assignmentVersion, 3);
  const row = await database.pool.query('SELECT status FROM coordination_assignments WHERE id = $1', [fixture.assignment.id]);
  assert.equal(row.rows[0].status, 'completed');
});

it('persists verification evidence in the completion transaction', async () => {
  const fixture = await reviewedAssignment();
  await complete(fixture, 2, 1);
  const row = await database.pool.query('SELECT status, evidence FROM coordination_verifications WHERE assignment_id = $1', [fixture.assignment.id]);
  assert.equal(row.rows[0].status, 'passed');
  assert.equal(row.rows[0].evidence[0].kind, 'command');
});

it('releases active claims when their assignment completes', async () => {
  const fixture = await readyAssignment();
  const claim = claimFor(fixture);
  await database.store.acquireClaim({ claim, expectedAssignmentVersion: 1, idempotencyKey: randomUUID() });
  await database.pool.query(`UPDATE coordination_assignments SET status = 'review' WHERE id = $1`, [fixture.assignment.id]);
  await complete(fixture, 3, 2);
  const row = await database.pool.query('SELECT status, released_at FROM coordination_resource_claims WHERE assignment_id = $1', [fixture.assignment.id]);
  assert.equal(row.rows[0].status, 'released');
  assert.ok(row.rows[0].released_at);
  const event = (await database.store.listEvents(fixture.workspace.id))
    .find((candidate) => candidate.type === 'assignment.completed');
  assert.deepEqual(event?.payload.releasedClaimIds, [claim.id]);
});

it('unlocks a queued dependent only after all dependencies complete', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  const first = assignmentFor(workspace.id, primary.id);
  const second = assignmentFor(workspace.id, primary.id, randomUUID(), { status: 'queued' });
  await database.store.createAssignment({ assignment: first, dependencyIds: [], actorAgentId: primary.id,
    expectedWorkspaceVersion: 1, idempotencyKey: randomUUID() });
  await database.store.createAssignment({ assignment: second, dependencyIds: [first.id], actorAgentId: primary.id,
    expectedWorkspaceVersion: 2, idempotencyKey: randomUUID() });
  await database.pool.query(`UPDATE coordination_assignments SET status = 'review' WHERE id = $1`, [first.id]);
  await complete({ workspace, primary, assignment: first }, 3, 1);
  const row = await database.pool.query('SELECT status FROM coordination_assignments WHERE id = $1', [second.id]);
  assert.equal(row.rows[0].status, 'ready');
});

it('appends completion before readiness events with gap-free sequences', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  const first = assignmentFor(workspace.id, primary.id);
  const second = assignmentFor(workspace.id, primary.id, randomUUID(), { status: 'queued' });
  await database.store.createAssignment({ assignment: first, dependencyIds: [], actorAgentId: primary.id, expectedWorkspaceVersion: 1, idempotencyKey: randomUUID() });
  await database.store.createAssignment({ assignment: second, dependencyIds: [first.id], actorAgentId: primary.id, expectedWorkspaceVersion: 2, idempotencyKey: randomUUID() });
  await database.pool.query(`UPDATE coordination_assignments SET status = 'review' WHERE id = $1`, [first.id]);
  await complete({ workspace, primary, assignment: first }, 3, 1);
  const events = await database.store.listEvents(workspace.id);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(events.slice(-3).map((event) => event.type), [
    'assignment.verified', 'assignment.completed', 'assignment.ready',
  ]);
});

it('rolls back completion when passed verification lacks evidence', async () => {
  const fixture = await reviewedAssignment();
  const invalid = { ...verification(), evidence: [] };
  await assert.rejects(complete(fixture, 2, 1, [invalid]));
  const row = await database.pool.query('SELECT status FROM coordination_assignments WHERE id = $1', [fixture.assignment.id]);
  assert.equal(row.rows[0].status, 'review');
});

it('rolls back completion on a stale workspace version', async () => {
  const fixture = await reviewedAssignment();
  await assert.rejects(complete(fixture, 99, 1));
  const count = await database.pool.query('SELECT count(*)::int AS count FROM coordination_verifications WHERE assignment_id = $1', [fixture.assignment.id]);
  assert.equal(count.rows[0].count, 0);
});

it('replays completion without duplicate verification or events', async () => {
  const fixture = await reviewedAssignment();
  const key = randomUUID();
  const results = [verification()];
  await complete(fixture, 2, 1, results, key);
  const replay = await complete(fixture, 2, 1, results, key);
  assert.equal(replay.replayed, true);
  const count = await database.pool.query('SELECT count(*)::int AS count FROM coordination_verifications WHERE assignment_id = $1', [fixture.assignment.id]);
  assert.equal(count.rows[0].count, 1);
});

it('rejects mutation of an existing audit event', async () => {
  const { workspace } = await seedWorkspace(database);
  await assert.rejects(database.pool.query(`UPDATE coordination_events SET type = 'tampered' WHERE workspace_id = $1`, [workspace.id]), /append-only/);
  await assert.rejects(database.pool.query(`DELETE FROM coordination_events WHERE workspace_id = $1`, [workspace.id]), /append-only/);
});

async function readyAssignment() {
  const { workspace, primary } = await seedWorkspace(database);
  const assignment = assignmentFor(workspace.id, primary.id);
  await database.store.createAssignment({ assignment, dependencyIds: [], actorAgentId: primary.id,
    expectedWorkspaceVersion: 1, idempotencyKey: randomUUID() });
  return { workspace, primary, assignment };
}

async function reviewedAssignment() {
  const fixture = await readyAssignment();
  await database.pool.query(`UPDATE coordination_assignments SET status = 'review' WHERE id = $1`, [fixture.assignment.id]);
  return fixture;
}

function claimFor(fixture: Awaited<ReturnType<typeof readyAssignment>>, overrides: Partial<ResourceClaim> = {}): ResourceClaim {
  return { id: randomUUID(), workspaceId: fixture.workspace.id, assignmentId: fixture.assignment.id,
    agentId: fixture.primary.id, resourceType: 'file', resourceId: 'src/a.ts', region: null,
    mode: 'write', status: 'active', leaseExpiresAt: null, ...overrides };
}

function verification(): VerificationResult {
  return { id: randomUUID(), criterionId: 'tests', status: 'passed',
    evidence: [{ kind: 'command', reference: 'npm test', sha256: 'a'.repeat(64) }],
    verifiedAt: new Date().toISOString() };
}

function complete(fixture: Awaited<ReturnType<typeof readyAssignment>>, workspaceVersion: number, assignmentVersion: number, verificationResults = [verification()], idempotencyKey = randomUUID()) {
  return database.store.completeAssignment({ workspaceId: fixture.workspace.id,
    assignmentId: fixture.assignment.id, actorAgentId: fixture.primary.id,
    expectedWorkspaceVersion: workspaceVersion, expectedAssignmentVersion: assignmentVersion,
    verificationResults, idempotencyKey });
}

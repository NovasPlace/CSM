import { randomUUID } from 'node:crypto';
import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CoordinationAgent, ResourceClaim } from '../dist/coordination/types.js';
import { assignmentFor, createCoordinationDatabase, destroyCoordinationDatabase, seedWorkspace, type CoordinationTestDatabase } from './coordination-persistence-fixture.js';

let database: CoordinationTestDatabase;

before(async () => { database = await createCoordinationDatabase('concurrency'); });
after(async () => { await destroyCoordinationDatabase(database); });

it('serializes concurrent matching idempotent assignment requests', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  const assignment = assignmentFor(workspace.id, primary.id);
  const request = { assignment, dependencyIds: [], actorAgentId: primary.id,
    expectedWorkspaceVersion: 1, idempotencyKey: randomUUID() };
  const results = await Promise.all([database.store.createAssignment(request), database.store.createAssignment(request)]);
  assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
  assert.equal((await database.store.readWorkspace(workspace.id)).assignments.length, 1);
});

it('allows only one concurrent mutation at an expected workspace version', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  const requests = [assignmentFor(workspace.id, primary.id), assignmentFor(workspace.id, primary.id)]
    .map((assignment) => database.store.createAssignment({ assignment, dependencyIds: [],
      actorAgentId: primary.id, expectedWorkspaceVersion: 1, idempotencyKey: randomUUID() }));
  const results = await Promise.allSettled(requests);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
});

it('allows only one concurrent conflicting write claim', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  const first = assignmentFor(workspace.id, primary.id);
  const second = assignmentFor(workspace.id, primary.id);
  await createAssignment(first, primary.id, 1);
  await createAssignment(second, primary.id, 2);
  const attempts = [first, second].map((assignment) => database.store.acquireClaim({
    claim: claim(workspace.id, assignment.id, primary.id), expectedAssignmentVersion: 1,
    idempotencyKey: randomUUID(),
  }));
  const results = await Promise.allSettled(attempts);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await database.store.readWorkspace(workspace.id)).claims.length, 1);
});

it('scopes identical idempotency keys independently by workspace', async () => {
  const left = await seedWorkspace(database);
  const right = await seedWorkspace(database);
  const key = 'shared-safe-key';
  const results = await Promise.all([
    database.store.createAssignment({ assignment: assignmentFor(left.workspace.id, left.primary.id),
      dependencyIds: [], actorAgentId: left.primary.id, expectedWorkspaceVersion: 1, idempotencyKey: key }),
    database.store.createAssignment({ assignment: assignmentFor(right.workspace.id, right.primary.id),
      dependencyIds: [], actorAgentId: right.primary.id, expectedWorkspaceVersion: 1, idempotencyKey: key }),
  ]);
  assert.ok(results.every((result) => !result.replayed));
});

it('serializes concurrent agent registrations using workspace versions', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  const requests = [member(workspace.id), member(workspace.id)].map((agent) =>
    database.store.registerAgent({ workspaceId: workspace.id, actorAgentId: primary.id,
      agent, expectedWorkspaceVersion: 1, idempotencyKey: randomUUID() }));
  const results = await Promise.allSettled(requests);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await database.store.readWorkspace(workspace.id)).agents.length, 2);
});

it('rolls back state and event sequence when final idempotency insertion fails', async () => {
  const suffix = randomUUID();
  const now = new Date().toISOString();
  const workspace = { id: `workspace-${suffix}`, projectId: 'project', sessionId: null,
    title: 'Rollback', objective: 'Reject empty key', primaryAgentId: `primary-${suffix}`,
    status: 'active' as const, version: 1, createdAt: now, updatedAt: now, completedAt: null };
  const primary: CoordinationAgent = { id: workspace.primaryAgentId, workspaceId: workspace.id,
    role: 'primary', status: 'working', capabilities: [], activeAssignmentId: null, lastHeartbeatAt: null };
  await assert.rejects(database.store.createWorkspace({ workspace, primaryAgent: primary, idempotencyKey: '' }));
  const count = await database.pool.query('SELECT count(*)::int AS count FROM coordination_workspaces WHERE id = $1', [workspace.id]);
  assert.equal(count.rows[0].count, 0);
});

it('paginates ordered events without duplicates or gaps', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  await createAssignment(assignmentFor(workspace.id, primary.id), primary.id, 1);
  await createAssignment(assignmentFor(workspace.id, primary.id), primary.id, 2);
  const first = await database.store.listEvents(workspace.id, 0, 2);
  const second = await database.store.listEvents(workspace.id, first.at(-1)?.sequence, 2);
  assert.deepEqual([...first, ...second].map((event) => event.sequence), [1, 2, 3]);
});

it('rejects invalid event page cursors and limits before SQL', async () => {
  const { workspace } = await seedWorkspace(database);
  await assert.rejects(database.store.listEvents(workspace.id, -1, 10));
  await assert.rejects(database.store.listEvents(workspace.id, 0, 1001));
});

function createAssignment(assignment: ReturnType<typeof assignmentFor>, actorAgentId: string, expectedWorkspaceVersion: number) {
  return database.store.createAssignment({ assignment, dependencyIds: [], actorAgentId,
    expectedWorkspaceVersion, idempotencyKey: randomUUID() });
}

function claim(workspaceId: string, assignmentId: string, agentId: string): ResourceClaim {
  return { id: randomUUID(), workspaceId, assignmentId, agentId, resourceType: 'file',
    resourceId: 'src/a.ts', region: null, mode: 'write', status: 'active', leaseExpiresAt: null };
}

function member(workspaceId: string): CoordinationAgent {
  return { id: randomUUID(), workspaceId, role: 'implementation', status: 'idle', capabilities: [],
    activeAssignmentId: null, lastHeartbeatAt: null };
}

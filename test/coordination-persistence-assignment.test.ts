import { randomUUID } from 'node:crypto';
import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { assignmentFor, createCoordinationDatabase, destroyCoordinationDatabase, seedWorkspace, type CoordinationTestDatabase } from './coordination-persistence-fixture.js';

let database: CoordinationTestDatabase;

before(async () => { database = await createCoordinationDatabase('assignment'); });
after(async () => { await destroyCoordinationDatabase(database); });

it('atomically creates a ready assignment without dependencies', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  const assignment = assignmentFor(workspace.id, primary.id);
  const result = await create(assignment, primary.id, 1);
  assert.equal(result.workspaceVersion, 2);
  assert.equal(result.assignmentVersion, 1);
});

it('persists structured assignment fields as round-trippable JSONB', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  const assignment = assignmentFor(workspace.id, primary.id);
  await create(assignment, primary.id, 1);
  const stored = (await database.store.readWorkspace(workspace.id)).assignments[0];
  assert.deepEqual(stored.allowedResources, assignment.allowedResources);
  assert.deepEqual(stored.completionCriteria, assignment.completionCriteria);
});

it('creates a queued assignment with an existing dependency', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  const dependency = assignmentFor(workspace.id, primary.id);
  await create(dependency, primary.id, 1);
  const child = assignmentFor(workspace.id, primary.id, randomUUID(), { status: 'queued' });
  await create(child, primary.id, 2, [dependency.id]);
  const rows = await database.pool.query('SELECT depends_on_assignment_id FROM coordination_dependencies WHERE assignment_id = $1', [child.id]);
  assert.equal(rows.rows[0].depends_on_assignment_id, dependency.id);
});

it('increments the workspace event sequence with assignment creation', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  await create(assignmentFor(workspace.id, primary.id), primary.id, 1);
  const events = await database.store.listEvents(workspace.id);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
  assert.equal(events[1].type, 'assignment.created');
});

it('replays assignment creation without duplicate rows', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  const assignment = assignmentFor(workspace.id, primary.id);
  const request = requestFor(assignment, primary.id, 1);
  await database.store.createAssignment(request);
  const replay = await database.store.createAssignment(request);
  assert.equal(replay.replayed, true);
  assert.equal((await database.store.readWorkspace(workspace.id)).assignments.length, 1);
});

it('rejects changed assignment content under a reused key', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  const assignment = assignmentFor(workspace.id, primary.id);
  const request = requestFor(assignment, primary.id, 1);
  await database.store.createAssignment(request);
  await assert.rejects(database.store.createAssignment({ ...request,
    assignment: { ...assignment, objective: 'Changed objective' } }),
  (error: unknown) => (error as { code?: string }).code === 'IDEMPOTENCY_CONFLICT');
});

it('rejects stale workspace versions and rolls back the assignment', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  const assignment = assignmentFor(workspace.id, primary.id);
  await assert.rejects(create(assignment, primary.id, 4));
  assert.equal((await database.store.readWorkspace(workspace.id)).assignments.length, 0);
});

it('rejects missing dependencies without a partial assignment or event', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  const assignment = assignmentFor(workspace.id, primary.id, randomUUID(), { status: 'queued' });
  await assert.rejects(create(assignment, primary.id, 1, ['missing']));
  const state = await database.store.readWorkspace(workspace.id);
  assert.equal(state.assignments.length, 0);
  assert.equal(state.events.length, 1);
});

it('rejects duplicate dependency identifiers deterministically', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  const assignment = assignmentFor(workspace.id, primary.id, randomUUID(), { status: 'queued' });
  await assert.rejects(create(assignment, primary.id, 1, ['same', 'same']), /unique/);
});

it('rejects self-dependencies deterministically', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  const assignment = assignmentFor(workspace.id, primary.id, randomUUID(), { status: 'queued' });
  await assert.rejects(create(assignment, primary.id, 1, [assignment.id]), /cannot reference/);
});

it('requires queued state when unresolved dependencies exist', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  const dependency = assignmentFor(workspace.id, primary.id);
  await create(dependency, primary.id, 1);
  const invalid = assignmentFor(workspace.id, primary.id);
  await assert.rejects(create(invalid, primary.id, 2, [dependency.id]), /must start queued/);
});

it('requires ready state when no dependencies exist', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  const invalid = assignmentFor(workspace.id, primary.id, randomUUID(), { status: 'queued' });
  await assert.rejects(create(invalid, primary.id, 1), /must start ready/);
});

it('bounds assignment read models and rejects oversized limits', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  let version = 1;
  for (let index = 0; index < 5; index += 1) {
    await create(assignmentFor(workspace.id, primary.id), primary.id, version);
    version += 1;
  }
  const state = await database.store.readWorkspace(workspace.id, { assignmentLimit: 3 });
  assert.equal(state.assignments.length, 3);
  assert.equal(state.pageInfo.assignmentsHasMore, true);
  await assert.rejects(database.store.readWorkspace(workspace.id, { assignmentLimit: 1001 }));
});

it('rejects creation with a pre-incremented assignment version', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  const assignment = assignmentFor(workspace.id, primary.id, randomUUID(), { version: 2 });
  await assert.rejects(create(assignment, primary.id, 1), /version 1/);
});

function requestFor(assignment: ReturnType<typeof assignmentFor>, actorAgentId: string, expectedWorkspaceVersion: number, dependencyIds: string[] = []) {
  return { assignment, dependencyIds, actorAgentId, expectedWorkspaceVersion,
    idempotencyKey: `create-${assignment.id}` };
}

function create(assignment: ReturnType<typeof assignmentFor>, actorId: string, version: number, dependencies: string[] = []) {
  return database.store.createAssignment(requestFor(assignment, actorId, version, dependencies));
}

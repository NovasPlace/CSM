import { randomUUID } from 'node:crypto';
import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { assignmentFor, createCoordinationDatabase, destroyCoordinationDatabase, seedWorkspace, type CoordinationTestDatabase } from './coordination-persistence-fixture.js';

let database: CoordinationTestDatabase;

before(async () => { database = await createCoordinationDatabase('integrity'); });
after(async () => { await destroyCoordinationDatabase(database); });

it('rejects a missing parent assignment and rolls back creation', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  const assignment = assignmentFor(workspace.id, primary.id, randomUUID(), { parentAssignmentId: 'missing-parent' });
  await assert.rejects(database.store.createAssignment({ assignment, dependencyIds: [],
    actorAgentId: primary.id, expectedWorkspaceVersion: 1, idempotencyKey: randomUUID() }));
  assert.equal((await database.store.readWorkspace(workspace.id)).assignments.length, 0);
});

it('prevents deletion of an assignment that is still a parent', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  const parent = assignmentFor(workspace.id, primary.id);
  await database.store.createAssignment({ assignment: parent, dependencyIds: [], actorAgentId: primary.id,
    expectedWorkspaceVersion: 1, idempotencyKey: randomUUID() });
  const child = assignmentFor(workspace.id, primary.id, randomUUID(), { parentAssignmentId: parent.id });
  await database.store.createAssignment({ assignment: child, dependencyIds: [], actorAgentId: primary.id,
    expectedWorkspaceVersion: 2, idempotencyKey: randomUUID() });
  await assert.rejects(database.pool.query('DELETE FROM coordination_assignments WHERE id = $1', [parent.id]));
  const count = await database.pool.query('SELECT count(*)::int AS count FROM coordination_assignments WHERE id = $1', [parent.id]);
  assert.equal(count.rows[0].count, 1);
});

it('exercises the idempotency workspace foreign key with a valid request hash', async () => {
  await assert.rejects(database.pool.query(
    `INSERT INTO coordination_idempotency_keys
      (workspace_id,idempotency_key,operation,request_hash,result)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    ['missing-workspace', 'valid-key', 'test', 'a'.repeat(64), '{}'],
  ), (error: unknown) => (error as { code?: string }).code === '23503');
});

it('returns a bounded large-workspace page with an explicit continuation signal', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  await database.pool.query(
    `INSERT INTO coordination_assignments
      (id,workspace_id,assigned_agent_id,title,objective,instructions,status,priority,risk,
       allowed_resources,required_deliverables,completion_criteria,requires_verification,
       requires_user_approval,version)
     SELECT $1 || n, $2, $3, 'Bulk task', 'Exercise bounded reads', 'No mutation',
       'ready', 1, 'low', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, false, false, 1
     FROM generate_series(1,1001) AS n`,
    [`bulk-${randomUUID()}-`, workspace.id, primary.id],
  );
  const state = await database.store.readWorkspace(workspace.id, { assignmentLimit: 1000 });
  assert.equal(state.assignments.length, 1000);
  assert.equal(state.pageInfo.assignmentsHasMore, true);
});

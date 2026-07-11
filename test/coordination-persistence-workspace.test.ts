import { randomUUID } from 'node:crypto';
import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { CoordinationPersistenceStore } from '../dist/coordination-persistence/store.js';
import type { CoordinationAgent } from '../dist/coordination/types.js';
import { createCoordinationDatabase, destroyCoordinationDatabase, seedWorkspace, type CoordinationTestDatabase } from './coordination-persistence-fixture.js';

let database: CoordinationTestDatabase;

before(async () => { database = await createCoordinationDatabase('workspace'); });
after(async () => { await destroyCoordinationDatabase(database); });

it('atomically persists a workspace and its primary agent', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  const rows = await database.pool.query('SELECT primary_agent_id, version FROM coordination_workspaces WHERE id = $1', [workspace.id]);
  const agents = await database.pool.query('SELECT role FROM coordination_agents WHERE id = $1', [primary.id]);
  assert.deepEqual(rows.rows[0], { primary_agent_id: primary.id, version: 1 });
  assert.equal(agents.rows[0].role, 'primary');
});

it('records workspace creation as the first ordered event', async () => {
  const { workspace } = await seedWorkspace(database);
  const events = await database.store.listEvents(workspace.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].sequence, 1);
  assert.equal(events[0].type, 'workspace.created');
});

it('returns a replay without duplicating workspace state or events', async () => {
  const suffix = randomUUID();
  const { workspace, primary } = await seedWorkspace(database, suffix);
  const replay = await database.store.createWorkspace({ workspace, primaryAgent: primary, idempotencyKey: `create-${suffix}` });
  assert.equal(replay.replayed, true);
  assert.equal((await database.store.listEvents(workspace.id)).length, 1);
});

it('rejects idempotency-key reuse with changed content', async () => {
  const suffix = randomUUID();
  const { workspace, primary } = await seedWorkspace(database, suffix);
  await assert.rejects(database.store.createWorkspace({
    workspace: { ...workspace, title: 'Changed title' }, primaryAgent: primary,
    idempotencyKey: `create-${suffix}`,
  }), (error: unknown) => (error as { code?: string }).code === 'IDEMPOTENCY_CONFLICT');
});

it('rolls back workspace creation when the session foreign key is invalid', async () => {
  const suffix = randomUUID();
  const now = new Date().toISOString();
  const workspace = { id: `workspace-${suffix}`, projectId: 'project', sessionId: 'missing',
    title: 'Invalid session', objective: 'Must roll back', primaryAgentId: `primary-${suffix}`,
    status: 'active' as const, version: 1, createdAt: now, updatedAt: now, completedAt: null };
  const primary: CoordinationAgent = { id: workspace.primaryAgentId, workspaceId: workspace.id,
    role: 'primary', status: 'working', capabilities: [], activeAssignmentId: null, lastHeartbeatAt: null };
  await assert.rejects(database.store.createWorkspace({ workspace, primaryAgent: primary, idempotencyKey: 'bad-session' }));
  const count = await database.pool.query('SELECT count(*)::int AS count FROM coordination_workspaces WHERE id = $1', [workspace.id]);
  assert.equal(count.rows[0].count, 0);
});

it('rejects a non-primary roster before persistence', async () => {
  const suffix = randomUUID();
  const now = new Date().toISOString();
  const workspace = { id: `workspace-${suffix}`, projectId: 'project', sessionId: null,
    title: 'Roster', objective: 'Validate primary', primaryAgentId: `agent-${suffix}`,
    status: 'active' as const, version: 1, createdAt: now, updatedAt: now, completedAt: null };
  const agent: CoordinationAgent = { id: workspace.primaryAgentId, workspaceId: workspace.id,
    role: 'review', status: 'working', capabilities: [], activeAssignmentId: null, lastHeartbeatAt: null };
  await assert.rejects(database.store.createWorkspace({ workspace, primaryAgent: agent, idempotencyKey: 'bad-role' }));
});

it('registers a non-primary agent and increments workspace version', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  const agent = member(workspace.id);
  const result = await database.store.registerAgent({ workspaceId: workspace.id, actorAgentId: primary.id,
    agent, expectedWorkspaceVersion: 1, idempotencyKey: `register-${agent.id}` });
  assert.equal(result.workspaceVersion, 2);
  assert.equal((await database.store.readWorkspace(workspace.id)).agents.length, 2);
});

it('replays agent registration without another version or event', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  const agent = member(workspace.id);
  const request = { workspaceId: workspace.id, actorAgentId: primary.id,
    agent, expectedWorkspaceVersion: 1, idempotencyKey: `register-${agent.id}` };
  await database.store.registerAgent(request);
  const replay = await database.store.registerAgent(request);
  assert.equal(replay.replayed, true);
  assert.equal((await database.store.listEvents(workspace.id)).length, 2);
});

it('rejects registration from a non-primary agent without mutation', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  const actor = member(workspace.id);
  await database.store.registerAgent({ workspaceId: workspace.id, actorAgentId: primary.id,
    agent: actor, expectedWorkspaceVersion: 1, idempotencyKey: `register-${actor.id}` });
  const target = member(workspace.id);
  await assert.rejects(database.store.registerAgent({ workspaceId: workspace.id, actorAgentId: actor.id,
    agent: target, expectedWorkspaceVersion: 2, idempotencyKey: `register-${target.id}` }));
  assert.equal((await database.store.readWorkspace(workspace.id)).agents.length, 2);
});

it('rejects stale workspace versions without writing an idempotency result', async () => {
  const { workspace, primary } = await seedWorkspace(database);
  const agent = member(workspace.id);
  await assert.rejects(database.store.registerAgent({ workspaceId: workspace.id, actorAgentId: primary.id,
    agent, expectedWorkspaceVersion: 9, idempotencyKey: `stale-${agent.id}` }));
  const keys = await database.pool.query('SELECT count(*)::int AS count FROM coordination_idempotency_keys WHERE workspace_id = $1', [workspace.id]);
  assert.equal(keys.rows[0].count, 1);
});

it('reconstructs durable state through a new store instance', async () => {
  const { workspace } = await seedWorkspace(database);
  const restarted = new CoordinationPersistenceStore(database.adapter);
  const state = await restarted.readWorkspace(workspace.id);
  assert.equal(state.workspace.id, workspace.id);
  assert.equal(state.events[0].type, 'workspace.created');
});

it('rejects missing workspaces with a deterministic error code', async () => {
  await assert.rejects(database.store.readWorkspace('missing-workspace'),
    (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND');
});

it('rejects creation with a pre-incremented workspace version', async () => {
  const suffix = randomUUID();
  const { workspace, primary } = await seedWorkspace(database, suffix);
  await assert.rejects(database.store.createWorkspace({ workspace: { ...workspace, id: `${workspace.id}-new`,
    primaryAgentId: `${primary.id}-new`, version: 2 }, primaryAgent: { ...primary, id: `${primary.id}-new`,
    workspaceId: `${workspace.id}-new` }, idempotencyKey: 'invalid-version' }));
});

function member(workspaceId: string): CoordinationAgent {
  const id = `agent-${randomUUID()}`;
  return { id, workspaceId, role: 'implementation', status: 'idle', capabilities: ['typescript'],
    activeAssignmentId: null, lastHeartbeatAt: null };
}

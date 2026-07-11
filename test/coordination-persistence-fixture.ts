import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { initializeCoordinationPersistenceSchema } from '../dist/coordination-persistence/schema.js';
import { CoordinationPersistenceStore } from '../dist/coordination-persistence/store.js';
import type { CoordinationAgent, CoordinationAssignment, CoordinationWorkspace } from '../dist/coordination/types.js';
import type { DatabasePool } from '../dist/types.js';

const BASE_URL = process.env.CSM_DATABASE_URL ?? process.env.DATABASE_URL
  ?? 'postgresql://postgres:postgres@localhost:5432/cross_session_memory';

export interface CoordinationTestDatabase {
  admin: Pool;
  name: string;
  pool: Pool;
  adapter: DatabasePool;
  store: CoordinationPersistenceStore;
}

export async function createCoordinationDatabase(label: string): Promise<CoordinationTestDatabase> {
  const name = `csm_coord_${label}_${Date.now()}_${randomUUID().slice(0, 8)}`.replace(/-/g, '_');
  const admin = new Pool({ connectionString: databaseUrl('postgres') });
  await admin.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
  const pool = new Pool({ connectionString: databaseUrl(name) });
  await pool.query('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
  const adapter = adapt(pool);
  await initializeCoordinationPersistenceSchema(adapter);
  return { admin, name, pool, adapter, store: new CoordinationPersistenceStore(adapter) };
}

export async function destroyCoordinationDatabase(database: CoordinationTestDatabase): Promise<void> {
  await database.pool.end();
  await database.admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [database.name]);
  await database.admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database.name)}`);
  await database.admin.end();
}

export async function seedWorkspace(
  database: CoordinationTestDatabase,
  suffix = randomUUID(),
): Promise<{ workspace: CoordinationWorkspace; primary: CoordinationAgent }> {
  const now = new Date().toISOString();
  const workspace: CoordinationWorkspace = {
    id: `workspace-${suffix}`, projectId: `project-${suffix}`, sessionId: null,
    title: 'Enterprise coordination', objective: 'Preserve deterministic durable work state',
    primaryAgentId: `primary-${suffix}`, status: 'active', version: 1,
    createdAt: now, updatedAt: now, completedAt: null,
  };
  const primary: CoordinationAgent = {
    id: workspace.primaryAgentId, workspaceId: workspace.id, role: 'primary',
    status: 'working', capabilities: ['coordinate'], activeAssignmentId: null,
    lastHeartbeatAt: now,
  };
  await database.store.createWorkspace({ workspace, primaryAgent: primary, idempotencyKey: `create-${suffix}` });
  return { workspace, primary };
}

export function assignmentFor(
  workspaceId: string,
  agentId: string,
  suffix = randomUUID(),
  overrides: Partial<CoordinationAssignment> = {},
): CoordinationAssignment {
  return {
    id: `assignment-${suffix}`, workspaceId, parentAssignmentId: null,
    assignedAgentId: agentId, title: 'Bounded task', objective: 'Produce an evidenced result',
    instructions: 'Operate only inside the assigned scope.', status: 'ready', priority: 10,
    risk: 'medium', allowedResources: [{ resourceType: 'file', resourceId: 'src/a.ts', region: null, mode: 'write' }],
    requiredDeliverables: [{ id: 'patch', description: 'Reviewed patch', required: true }],
    completionCriteria: [{ id: 'tests', description: 'Tests pass', required: true }],
    requiresVerification: true, requiresUserApproval: false, version: 1, ...overrides,
  };
}

function adapt(pool: Pool): DatabasePool {
  return {
    query: (text, params) => pool.query(text, params),
    connect: () => pool.connect(), end: () => pool.end(), getDialect: () => 'pg',
  };
}

function databaseUrl(name: string): string {
  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

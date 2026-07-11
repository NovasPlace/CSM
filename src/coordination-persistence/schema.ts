import type { DatabasePool } from '../types.js';
import { initializeCoordinationArtifactSchema } from './schema-artifacts.js';
import { initializeCoordinationAssignmentSchema } from './schema-assignment.js';
import { initializeCoordinationClaimSchema } from './schema-claims.js';
import { initializeCoordinationEventSchema } from './schema-events.js';
import { initializeCoordinationGovernanceSchema } from './schema-governance.js';
import { initializeCoordinationWorkspaceSchema } from './schema-workspace.js';

export async function initializeCoordinationPersistenceSchema(pool: DatabasePool): Promise<void> {
  requirePostgres(pool);
  await initializeCoordinationWorkspaceSchema(pool);
  await initializeCoordinationAssignmentSchema(pool);
  await initializeCoordinationClaimSchema(pool);
  await initializeCoordinationArtifactSchema(pool);
  await initializeCoordinationGovernanceSchema(pool);
  await initializeCoordinationEventSchema(pool);
}

function requirePostgres(pool: DatabasePool): void {
  if (pool.getDialect?.() !== 'pg') {
    throw new Error('Coordination persistence requires PostgreSQL');
  }
}

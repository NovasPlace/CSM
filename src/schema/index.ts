import { initializeCheckpointSchema } from '../checkpoint-schema.js';
import { initializeCandidateSchema } from '../candidate-schema.js';
import { initializeExperiencePacketSchema } from '../experience-packet-schema.js';
import { initializeSelfModelSchema } from '../self-model-schema.js';
import { initializeBeliefKnowledgeSchema } from '../belief-knowledge-schema.js';
import { initializeContextCompilationSchema } from '../context-compilation-schema.js';
import { initializeContextCacheSchema } from '../context-cache-schema.js';
import { initializeRolloverSchema } from '../context-rollover-schema.js';
import { initializeCrossSessionCausalSchema } from '../cross-session-causal-schema.js';
import type { Database } from '../database.js';
import type { DatabasePool } from '../types.js';
import { initializeGoalSchema } from '../goal-schema.js';
import { initializeGraphSchema } from '../memory-graph.js';
import { initializeRecallTelemetrySchema } from '../recall-telemetry.js';
import { initializeSelfContinuitySchema } from '../self-continuity-schema.js';
import { initializeTraceVaultSchema } from '../trace-vault-store.js';
import { initializeWorkJournalSchema } from '../work-journal-schema.js';
import { initializeCoreSchema } from './core-schema.js';
import { initializeMemorySchema } from './memory-schema.js';
import { migrateProjectIsolation } from './project-isolation-schema.js';
import { isOwnershipLimitedSchemaError } from './schema-errors.js';
import { initializeSessionSchema } from './session-schema.js';
import { initializeMinimalSqliteSchema } from './sqlite/index.js';
import { getLogger } from '../logger.js';

/**
 * Bump this whenever a step in `initializeAllSchemas` changes what it creates.
 * Databases recorded at an older version get a full (idempotent) re-initialization.
 */
export const SCHEMA_VERSION = 1;

const SCHEMA_STATE_TABLE = 'csm_schema_state';

function forceSchemaInit(): boolean {
  return process.env['CSM_SCHEMA_FORCE_INIT'] === 'true';
}

async function schemaIsCurrent(pool: DatabasePool): Promise<boolean> {
  try {
    const result = await pool.query(`SELECT version FROM ${SCHEMA_STATE_TABLE} WHERE id = 1`);
    const row = result.rows[0] as { version?: number } | undefined;
    return row?.version === SCHEMA_VERSION;
  } catch {
    // Marker table absent (fresh database) or unreadable — do the full initialization.
    return false;
  }
}

async function recordSchemaVersion(pool: DatabasePool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA_STATE_TABLE} (
      id INT PRIMARY KEY,
      version INT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(
    `INSERT INTO ${SCHEMA_STATE_TABLE} (id, version) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, updated_at = now()`,
    [SCHEMA_VERSION],
  );
}

export async function initializeAllSchemas(database: Database): Promise<void> {
  const pool = database.getPool();
  const provider = database.getProvider();

  if (provider === 'sqlite') {
    await initializeMinimalSqliteSchema(pool);
    getLogger().info('SQLite minimal schema initialized');
    return;
  }

  // Fast path. Every step below is idempotent, but together they issue ~147 statements,
  // each its own network round-trip, on EVERY process start — and one process is spawned
  // per client surface. Against a remote database that is tens of seconds of pure latency
  // before the first tool call can be served. When this database has already been
  // initialized at this schema version, a single SELECT replaces all of it.
  if (!forceSchemaInit() && (await schemaIsCurrent(pool))) {
    getLogger().debug(`Schema already at version ${SCHEMA_VERSION}; skipping initialization`);
    return;
  }

  const ownershipLimitedSteps: string[] = [];
  const failedSteps: string[] = [];

  const steps: Array<[string, () => Promise<void>]> = [
    ['extension.vector', () => provider === 'sqlite' ? Promise.resolve() : pool.query('CREATE EXTENSION IF NOT EXISTS vector').then(() => undefined)],
    ['session', () => initializeSessionSchema(pool)],
    ['memory', () => initializeMemorySchema(pool)],
    ['core', () => initializeCoreSchema(pool)],
    ['project-isolation', () => migrateProjectIsolation(pool)],
    ['checkpoint', () => initializeCheckpointSchema(pool)],
    ['context-compilation', () => initializeContextCompilationSchema(pool)],
    ['context-cache', () => initializeContextCacheSchema(pool)],
    ['rollover', () => initializeRolloverSchema(pool)],
    ['goal', () => initializeGoalSchema(pool)],
    ['recall-telemetry', () => initializeRecallTelemetrySchema(pool)],
    ['self-continuity', () => initializeSelfContinuitySchema(pool)],
    ['cross-session-causal', () => initializeCrossSessionCausalSchema(pool)],
    ['trace-vault', () => initializeTraceVaultSchema(pool)],
    ['graph', () => initializeGraphSchema(database)],
    ['work-journal', () => initializeWorkJournalSchema(pool)],
    ['candidate-queue', () => initializeCandidateSchema(pool)],
    ['experience-packet', () => initializeExperiencePacketSchema(pool)],
    ['self-model', () => initializeSelfModelSchema(pool)],
    ['belief-knowledge', () => initializeBeliefKnowledgeSchema(pool)],
  ];

  for (const [name, step] of steps) {
    try {
      await step();
    } catch (error) {
       if (isOwnershipLimitedSchemaError(error)) {
         ownershipLimitedSteps.push(name);
         continue;
       }
       failedSteps.push(name);
       getLogger().error(`Schema step failed (${name}); continuing`, error instanceof Error ? error : undefined);
     }
   }
 
   if (ownershipLimitedSteps.length > 0) {
     getLogger().info(`Schema steps skipped due to ownership limits: ${ownershipLimitedSteps.join(', ')}`);
   }

  // Only record the version after a fully clean pass. If a step failed, or was skipped for
  // ownership reasons, leave the marker alone so the next start retries the whole thing.
  if (failedSteps.length === 0 && ownershipLimitedSteps.length === 0) {
    try {
      await recordSchemaVersion(pool);
    } catch {
      getLogger().warn('Could not record schema version; the next start will re-run initialization');
    }
  }
 }

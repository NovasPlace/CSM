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
import type { DatabaseClient, DatabasePool } from '../types.js';
import {
  ensureMigrationLedger,
  type MigrationProvider,
  readMigrationHistory,
  recordMigration,
  type SchemaMigration,
  validateMigrationHistory,
} from './migration-ledger.js';
import { artifactsFor } from './migration-artifacts.js';
import { buildPostgresMigrations } from './postgres-migrations.js';
import { SchemaStepError } from './schema-errors.js';
import { initializeMinimalSqliteSchema } from './sqlite/index.js';

const SCHEMA_LOCK_KEY = 741_583_921;
const SAVEPOINT = 'csm_schema_migration';

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
  const provider = toMigrationProvider(database.getProvider());
  await withSchemaTransaction(pool, provider, async (transactionPool) => {
    if (provider === 'postgres') await lockPostgresSchema(transactionPool);
    const migrations = buildMigrations(database, transactionPool, provider);
    await migrateSchema(transactionPool, migrations, provider);
  });
  getLogger().info(`${provider === 'sqlite' ? 'SQLite' : 'PostgreSQL'} schema ready`);
}

function buildMigrations(
  database: Database,
  pool: DatabasePool,
  provider: MigrationProvider,
): SchemaMigration[] {
  if (provider === 'postgres') return buildPostgresMigrations(database, pool);
  return [{
    id: '20260709-001-sqlite-baseline',
    contract: 'csm-sqlite-v1:core memory, graph, recall, packets, self-model, and beliefs',
    implementation: artifactsFor('20260709-001-sqlite-baseline'),
    run: () => initializeMinimalSqliteSchema(pool),
  }];
}

async function migrateSchema(
  pool: DatabasePool,
  migrations: SchemaMigration[],
  provider: MigrationProvider,
): Promise<void> {
  await ensureMigrationLedger(pool, provider);
  const applied = await readMigrationHistory(pool);
  validateMigrationHistory(migrations, applied, provider);
  const appliedIds = new Set(applied.map((migration) => migration.id));
  for (const migration of migrations) {
    if (!appliedIds.has(migration.id)) {
      await applyMigration(pool, migration, provider);
    }
  }
}

async function applyMigration(
  pool: DatabasePool,
  migration: SchemaMigration,
  provider: MigrationProvider,
): Promise<void> {
  await pool.query(`SAVEPOINT ${SAVEPOINT}`);
  const startedAt = Date.now();
  try {
    await migration.run();
    await recordMigration(pool, migration, provider, Date.now() - startedAt);
    await pool.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
  } catch (error) {
    const rollbackError = await rollbackMigration(pool);
    throw new SchemaStepError(migration.id, error, rollbackError);
  }
}

async function rollbackMigration(pool: DatabasePool): Promise<unknown | undefined> {
  try {
    await pool.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
    await pool.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    return undefined;
  } catch (error) {
    return error;
  }
}

async function withSchemaTransaction<T>(
  pool: DatabasePool,
  provider: MigrationProvider,
  task: (transactionPool: DatabasePool) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query(provider === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
    transactionOpen = true;
    const result = await task(poolFromClient(client, provider));
    await client.query('COMMIT');
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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

function poolFromClient(
  client: DatabaseClient,
  provider: MigrationProvider,
): DatabasePool {
  return {
    query: (text, params) => client.query(text, params),
    connect: async () => client,
    end: async () => undefined,
    getDialect: () => provider === 'postgres' ? 'pg' : 'sqlite',
  };
}

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

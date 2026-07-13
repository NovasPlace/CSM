import type { Database } from '../database.js';
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
import { migrateCompactionMetricsSqlite } from './sqlite/compaction-metrics-migration.js';
import { initializeSqliteWorkJournal } from './sqlite/work-journal.js';
import { runCapabilityProvenanceMigration } from './capability-provenance-migration.js';
import { initializeContextInjectionTelemetrySchema } from './context-injection-telemetry-schema.js';
import { initializeAgentBookSchema } from './agentbook-schema.js';

const SCHEMA_LOCK_KEY = 741_583_921;
const SAVEPOINT = 'csm_schema_migration';

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

export const SQLITE_MIGRATION_IDS: readonly string[] = [
  '20260709-001-sqlite-baseline',
  '20260711-002-sqlite-work-journal',
  '20260711-023-capability-provenance-rewrite',
  '20260711-024-sqlite-compaction-metrics',
  '20260712-025-sqlite-context-injection-telemetry',
  '20260713-026-sqlite-agentbook',
];

function buildMigrations(
  database: Database,
  pool: DatabasePool,
  provider: MigrationProvider,
): SchemaMigration[] {
  if (provider === 'postgres') return buildPostgresMigrations(database, pool);
  return [
    {
      id: SQLITE_MIGRATION_IDS[0],
      contract: 'csm-sqlite-v1:core memory, graph, recall, packets, self-model, and beliefs',
      implementation: artifactsFor('20260709-001-sqlite-baseline'),
      run: () => initializeMinimalSqliteSchema(pool),
    },
    {
      id: SQLITE_MIGRATION_IDS[1],
      contract: 'csm-sqlite-v2:persistent agent work journal',
      implementation: artifactsFor('20260711-002-sqlite-work-journal'),
      run: () => initializeSqliteWorkJournal(pool),
    },
    {
      id: SQLITE_MIGRATION_IDS[2],
      contract: 'csm-sqlite-v2:rewrite capability promotion memories as immutable provenance snapshots',
      implementation: artifactsFor('20260711-023-capability-provenance-rewrite'),
      acceptedLegacyChecksums: ['5f2309483f18cc3e9de81eba037489a7ce4b0727e5c58d2a0ba4ae5ef40c88f8'],
      run: () => runCapabilityProvenanceMigration(pool).then(() => undefined),
    },
    {
      id: SQLITE_MIGRATION_IDS[3],
      contract: 'csm-sqlite-v2:compaction telemetry metrics table with partial-schema repair',
      implementation: artifactsFor('20260711-024-sqlite-compaction-metrics'),
      run: () => migrateCompactionMetricsSqlite(pool),
    },
    {
      id: SQLITE_MIGRATION_IDS[4],
      contract: 'csm-sqlite-v2:context injection telemetry events and items',
      implementation: artifactsFor('20260712-025-sqlite-context-injection-telemetry'),
      run: () => initializeContextInjectionTelemetrySchema(pool),
    },
    {
      id: SQLITE_MIGRATION_IDS[5],
      contract: 'csm-sqlite-v2:agentbook operational ledger, summaries, current state, and rules',
      implementation: artifactsFor('20260713-026-sqlite-agentbook'),
      run: () => initializeAgentBookSchema(pool),
    },
  ];

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

async function lockPostgresSchema(pool: DatabasePool): Promise<void> {
  await pool.query('SELECT pg_advisory_xact_lock($1::bigint)', [SCHEMA_LOCK_KEY]);
}

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

function toMigrationProvider(provider: string): MigrationProvider {
  if (provider === 'postgres' || provider === 'sqlite') return provider;
  throw new Error(`Unsupported database provider: ${provider}`);
}

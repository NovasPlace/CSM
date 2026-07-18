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
import { buildPostgresMigrations } from './postgres-migrations.js';
import { SchemaStepError } from './schema-errors.js';
import { buildSqliteMigrations } from './sqlite-migrations.js';

export { SQLITE_MIGRATION_IDS } from './sqlite-migrations.js';

const SCHEMA_LOCK_KEY = 741_583_921;
const SAVEPOINT = 'csm_schema_migration';

export async function initializeAllSchemas(database: Database, dimensions = 1_536): Promise<void> {
  const pool = database.getPool();
  const provider = toMigrationProvider(database.getProvider());
  await withSchemaTransaction(pool, provider, async (transactionPool) => {
    if (provider === 'postgres') await lockPostgresSchema(transactionPool);
    const migrations = buildMigrations(database, transactionPool, provider, dimensions);
    await migrateSchema(transactionPool, migrations, provider);
  });
  getLogger().info(`${provider === 'sqlite' ? 'SQLite' : 'PostgreSQL'} schema ready`);
}

function buildMigrations(
  database: Database,
  pool: DatabasePool,
  provider: MigrationProvider,
  dimensions: number,
): SchemaMigration[] {
  if (provider === 'postgres') return buildPostgresMigrations(database, pool, dimensions);
  return buildSqliteMigrations(pool);
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

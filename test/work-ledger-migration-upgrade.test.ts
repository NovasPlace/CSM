import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { DEFAULT_CONFIG } from '../src/config.js';
import { Database } from '../src/database.js';
import {
  ensureMigrationLedger,
  recordMigration,
} from '../src/schema/migration-ledger.js';
import { buildPostgresMigrations } from '../src/schema/postgres-migrations.js';
import type { DatabasePool } from '../src/types.js';

const BASE_URL = process.env.CSM_DATABASE_URL
  ?? 'postgresql://postgres:postgres@localhost:5432/cross_session_memory';
const DATABASE_NAME = `csm_work_ledger_upgrade_${Date.now()}`;
const admin = new Pool({ connectionString: databaseUrl('postgres') });
const config = {
  ...DEFAULT_CONFIG,
  databaseUrl: databaseUrl(DATABASE_NAME),
  databaseProvider: 'postgres' as const,
};
let current: Database | undefined;

function databaseUrl(name: string): string {
  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

before(async () => {
  await admin.query(`CREATE DATABASE ${quoteIdentifier(DATABASE_NAME)}`);
  const pool = new Pool({ connectionString: config.databaseUrl });
  const target = pool as unknown as DatabasePool;
  const database = new Database(config);
  try {
    await pool.query('BEGIN');
    await ensureMigrationLedger(target, 'postgres');
    for (const migration of buildPostgresMigrations(database, target).slice(0, 20)) {
      const startedAt = performance.now();
      await migration.run();
      await recordMigration(target, migration, 'postgres', performance.now() - startedAt);
    }
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  } finally {
    await pool.end();
  }
});

after(async () => {
  const errors: unknown[] = [];
  try { if (current) await current.close(); } catch (error) { errors.push(error); }
  try {
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [DATABASE_NAME]);
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(DATABASE_NAME)}`);
  } catch (error) { errors.push(error); }
  try { await admin.end(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Work Ledger upgrade cleanup failed');
});

it('upgrades csm-postgres-v1 to v2 with only migration 21', async () => {
  const beforePool = new Pool({ connectionString: config.databaseUrl });
  const before = await beforePool.query(
    `SELECT COUNT(*)::int AS count,
            to_regclass('public.work_ledger_changes') AS ledger_table
     FROM csm_schema_migrations`,
  );
  await beforePool.end();
  assert.equal(before.rows[0].count, 20);
  assert.equal(before.rows[0].ledger_table, null);
  current = new Database(config);
  await current.connect();
  const afterResult = await current.getPool().query(
    `SELECT COUNT(*)::int AS count,
            to_regclass('public.work_ledger_changes') AS ledger_table
     FROM csm_schema_migrations`,
  );
  assert.equal(afterResult.rows[0].count, 21);
  assert.equal(afterResult.rows[0].ledger_table, 'work_ledger_changes');
  const migration = await current.getPool().query(
    'SELECT migration_id FROM csm_schema_migrations ORDER BY applied_at DESC LIMIT 1',
  );
  assert.equal(migration.rows[0].migration_id, '20260710-021-work-ledger');
});

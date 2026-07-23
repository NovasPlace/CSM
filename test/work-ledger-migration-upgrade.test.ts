import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { DEFAULT_CONFIG } from '../src/config.js';
import { Database } from '../src/database.js';
import {
  ensureMigrationLedger,
  recordMigration,
} from '../src/schema/migration-ledger.js';
import { legacyArtifactsFor } from '../src/schema/migration-artifacts.js';
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
      const historical = {
        ...migration,
        implementation: legacyArtifactsFor(migration.id, migration.implementation),
      };
      await recordMigration(target, historical, 'postgres', performance.now() - startedAt);
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

it('upgrades csm-postgres-v1 through current migrations', async () => {
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
            to_regclass('public.work_ledger_changes') AS ledger_table,
            to_regclass('public.coordination_events') AS coordination_table
     FROM csm_schema_migrations`,
  );
  assert.equal(afterResult.rows[0].count, 28);
  assert.equal(afterResult.rows[0].ledger_table, 'work_ledger_changes');
  assert.equal(afterResult.rows[0].coordination_table, 'coordination_events');
  const vectors = await current.getPool().query(
    `SELECT c.relname AS table_name, a.attname AS column_name,
            a.atttypmod AS dimensions, a.attnotnull AS not_null
     FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('memories', 'memory_chunks')
       AND a.attname IN ('embedding', 'embedding_legacy_1536_before_768')
     ORDER BY c.relname, a.attname`,
  );
  const active = vectors.rows.filter((row) => row.column_name === 'embedding');
  const legacy = vectors.rows.filter((row) => row.column_name.startsWith('embedding_legacy_'));
  assert.deepEqual(active.map((row) => row.dimensions), [768, 768]);
  assert.equal(legacy.length, 2);
  assert.equal(legacy.every((row) => row.not_null === false), true);
  const migration = await current.getPool().query(
    `SELECT migration_id FROM csm_schema_migrations
     WHERE migration_id IN (
       '20260710-021-work-ledger', '20260710-022-coordination-persistence',
       '20260718-026-postgres-embedding-dimension',
       '20260718-027-postgres-embedding-dimension-repair',
       '20260721-028-compaction-attribution'
     )
     ORDER BY migration_id`,
  );
  assert.deepEqual(migration.rows.map((row) => row.migration_id), [
    '20260710-021-work-ledger', '20260710-022-coordination-persistence',
    '20260718-026-postgres-embedding-dimension',
    '20260718-027-postgres-embedding-dimension-repair',
    '20260721-028-compaction-attribution',
  ]);
});

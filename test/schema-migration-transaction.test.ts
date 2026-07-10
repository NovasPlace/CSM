import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { Database } from '../dist/database.js';
import type { PluginConfig } from '../dist/types.js';

const BASE_DB_URL = process.env.CSM_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgresql://postgres:postgres@localhost:5432/cross_session_memory';
const admin = new Pool({ connectionString: databaseUrl('postgres') });

function databaseUrl(databaseName: string): string {
  const url = new URL(BASE_DB_URL);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function config(databaseName: string): PluginConfig {
  return {
    databaseUrl: databaseUrl(databaseName),
    databaseProvider: 'postgres',
    sqlitePath: '.data/csm-memory.db',
    embeddingModel: 'nomic-embed-text',
    embeddingApiUrl: 'http://localhost:11434',
  } as PluginConfig;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function createDatabase(name: string): Promise<void> {
  await admin.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
}

async function dropDatabase(name: string): Promise<void> {
  await admin.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
    [name],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
}

after(async () => {
  await admin.end();
});

describe('real PostgreSQL migration transaction policy', () => {
  it('rolls back ledger and DDL when a required migration fails', async () => {
    const name = `csm_migration_rollback_${Date.now()}`;
    await createDatabase(name);
    const raw = new Pool({ connectionString: databaseUrl(name) });
    try {
      await raw.query("CREATE VIEW sessions AS SELECT 'legacy'::text AS id");
      const database = new Database(config(name));
      await assert.rejects(
        () => database.connect(),
        /Schema step failed \(20260709-002-session\)/,
      );
      assert.throws(() => database.getPool(), /Database not connected/);
      const result = await raw.query(
        `SELECT
          to_regclass('public.csm_schema_migrations') AS ledger,
          to_regclass('public.memories') AS memories,
          (SELECT relkind FROM pg_class WHERE oid = 'sessions'::regclass) AS session_kind`,
      );
      assert.equal(result.rows[0].ledger, null);
      assert.equal(result.rows[0].memories, null);
      assert.equal(result.rows[0].session_kind, 'v');
    } finally {
      await raw.end();
      await dropDatabase(name);
    }
  });

  it('serializes concurrent first startup without duplicate migrations', async () => {
    const name = `csm_migration_concurrent_${Date.now()}`;
    await createDatabase(name);
    const first = new Database(config(name));
    const second = new Database(config(name));
    try {
      await Promise.all([first.connect(), second.connect()]);
      const result = await first.getPool().query(
        'SELECT COUNT(*)::int AS count FROM csm_schema_migrations',
      );
      assert.equal(result.rows[0].count, 21);
      await assert.doesNotReject(() => second.getPool().query('SELECT 1'));
    } finally {
      await first.close();
      await second.close();
      await dropDatabase(name);
    }
  });
});

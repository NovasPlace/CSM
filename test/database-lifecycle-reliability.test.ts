import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { Database } from '../dist/database.js';
import { formatDatabaseDiagnostic } from '../dist/database-diagnostic.js';
import { createPostgresPool } from '../dist/db/postgres-pool.js';
import { DEFAULT_CONFIG } from '../dist/config.js';

const TMP_DIR = '.tmp/database-lifecycle';
const SQLITE_PATH = `${TMP_DIR}/lifecycle.sqlite`;
const BASE_URL = process.env.CSM_DATABASE_URL ?? process.env.DATABASE_URL
  ?? 'postgresql://postgres:postgres@localhost:5432/cross_session_memory';
let admin: Pool;
let postgresName: string;

before(async () => {
  mkdirSync(TMP_DIR, { recursive: true });
  cleanSqlite();
  postgresName = `csm_lifecycle_${Date.now()}_${randomUUID().slice(0, 8)}`.replace(/-/g, '_');
  admin = new Pool({ connectionString: databaseUrl('postgres') });
  await admin.query(`CREATE DATABASE ${quoteIdentifier(postgresName)}`);
});

after(async () => {
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [postgresName]);
  await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(postgresName)}`);
  await admin.end();
  cleanSqlite();
  try { rmSync(TMP_DIR); } catch { /* absent or not empty */ }
});

it('coalesces concurrent SQLite connect calls into one ready pool', async () => {
  const database = new Database(sqliteConfig(':memory:'));
  await Promise.all(Array.from({ length: 20 }, () => database.connect()));
  const pool = database.getPool();
  await database.connect();
  assert.equal(database.getPool(), pool);
  assert.equal((await database.diagnose()).startup.state, 'ready');
  await database.close();
});

it('makes concurrent close and disconnect idempotent', async () => {
  const database = new Database(sqliteConfig(':memory:'));
  await database.connect();
  await Promise.all([database.close(), database.disconnect(), database.close(), database.disconnect()]);
  const diagnostic = await database.diagnose();
  assert.equal(diagnostic.startup.state, 'closed');
  assert.equal(diagnostic.readiness.reason, 'not_connected');
});

it('reopens only after an in-flight shutdown and preserves SQLite state', async () => {
  const database = new Database(sqliteConfig(SQLITE_PATH));
  await database.connect();
  await database.getPool().query('CREATE TABLE lifecycle_sentinel (value TEXT NOT NULL)');
  await database.getPool().query('INSERT INTO lifecycle_sentinel (value) VALUES ($1)', ['preserved']);
  const closing = database.close();
  const reopening = database.connect();
  await Promise.all([closing, reopening]);
  const result = await database.getPool().query('SELECT value FROM lifecycle_sentinel');
  assert.equal((result.rows[0] as { value: string }).value, 'preserved');
  await database.close();
});

it('coalesces real PostgreSQL startup and records one migration history', async () => {
  const database = new Database({ ...DEFAULT_CONFIG, databaseProvider: 'postgres',
    databaseUrl: databaseUrl(postgresName) });
  await Promise.all(Array.from({ length: 10 }, () => database.connect()));
  const count = await database.getPool().query('SELECT count(*)::int AS count FROM csm_schema_migrations');
  assert.equal((count.rows[0] as { count: number }).count, 22);
  const pool = database.getPool();
  await database.connect();
  assert.equal(database.getPool(), pool);
  await database.close();
});

it('redacts database credentials from machine-readable diagnostics', () => {
  const diagnostic = formatDatabaseDiagnostic(new Error(
    'connect postgresql://private-user:private-pass@db.example/csm?password=query-secret',
  ));
  assert.doesNotMatch(diagnostic, /private-user|private-pass|query-secret/);
  assert.match(diagnostic, /\[REDACTED\]/);
});

it('retains and retries a pool handle after shutdown failure', async () => {
  const database = new Database(sqliteConfig(':memory:'));
  let endCalls = 0;
  const failingPool = { query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => { throw new Error('unused'); },
    end: async () => { endCalls += 1; if (endCalls === 1) throw new Error('transient close'); },
    getDialect: () => 'sqlite' as const };
  Object.assign(database, { pool: failingPool, startupState: 'ready' });
  await assert.rejects(database.close(), /transient close/);
  assert.equal((await database.diagnose()).startup.state, 'failed');
  await database.close();
  assert.equal(endCalls, 2);
  assert.equal((await database.diagnose()).startup.state, 'closed');
});

it('retains an unhealthy pool when detachment fails and closes it before reconnecting', async () => {
  const database = new Database(sqliteConfig(':memory:'));
  let endCalls = 0;
  const unhealthyPool = { query: async () => { throw new Error('health probe failed'); },
    connect: async () => { throw new Error('unused'); },
    end: async () => { endCalls += 1; if (endCalls === 1) throw new Error('transient close'); },
    getDialect: () => 'sqlite' as const };
  Object.assign(database, { pool: unhealthyPool, startupState: 'ready' });
  await assert.rejects(database.connect(), /Failed to close unhealthy database pool/);
  assert.equal((await database.diagnose()).startup.state, 'failed');
  await database.connect();
  assert.equal(endCalls, 2);
  assert.equal((await database.diagnose()).startup.state, 'ready');
  await database.close();
});

it('does not return PostgreSQL clients after pool shutdown begins', async () => {
  const pool = await createPostgresPool(databaseUrl(postgresName));
  const attempts = Array.from({ length: 20 }, () => pool.connect().then(
    (client) => { client.release(); return 'returned'; },
    () => 'rejected',
  ));
  const ending = pool.end();
  const results = await Promise.all(attempts);
  await ending;
  assert.deepEqual(new Set(results), new Set(['rejected']));
});

function sqliteConfig(path: string) {
  return { ...DEFAULT_CONFIG, databaseProvider: 'sqlite' as const, databaseUrl: path, sqlitePath: path };
}

function cleanSqlite(): void {
  for (const path of [SQLITE_PATH, `${SQLITE_PATH}-wal`, `${SQLITE_PATH}-shm`]) {
    try { rmSync(path); } catch { /* absent */ }
  }
}

function databaseUrl(name: string): string {
  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

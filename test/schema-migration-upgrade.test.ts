import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { Database } from '../dist/database.js';
import { EmbeddingGenerator } from '../dist/embeddings.js';
import { MemoryManager } from '../dist/memory-manager.js';
import type { PluginConfig } from '../dist/types.js';

const BASE_DB_URL = process.env.CSM_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgresql://postgres:postgres@localhost:5432/cross_session_memory';

function databaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function requireDatabase(database: Database | undefined): Database {
  if (!database) throw new Error('Upgrade fixture database is unavailable');
  return database;
}

async function cleanupUpgradeDatabase(
  admin: Pool,
  database: Database | undefined,
  databaseName: string,
  databaseCreated: boolean,
): Promise<void> {
  const errors: unknown[] = [];
  try { if (database) await database.close(); } catch (error) { errors.push(error); }
  if (databaseCreated) {
    try {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
    } catch (error) { errors.push(error); }
  }
  try { await admin.end(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Upgrade fixture cleanup failed');
}

  const databaseName = `csm_upgrade_${Date.now()}`;
  const admin = new Pool({ connectionString: databaseUrl(BASE_DB_URL, 'postgres') });
  const config = {
    databaseUrl: databaseUrl(BASE_DB_URL, databaseName),
    databaseProvider: 'postgres',
    sqlitePath: '.data/csm-memory.db',
    embeddingModel: 'nomic-embed-text',
    embeddingApiUrl: 'http://localhost:11434',
  } as PluginConfig;
  let database: Database | undefined;
  let databaseCreated = false;

  before(async () => {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    const legacy = new Pool({ connectionString: config.databaseUrl });
    await legacy.query(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await legacy.query(
      'INSERT INTO sessions (id, project_id, title) VALUES ($1, $2, $3)',
      ['legacy-session', 'legacy-project', 'Legacy session'],
    );
    await legacy.end();
    database = new Database(config);
    await database.connect();
  });

  after(async () => {
    await cleanupUpgradeDatabase(admin, database, databaseName, databaseCreated);
  });

  it('supported matrix: upgrades legacy-unversioned without losing its session', async () => {
    const result = await requireDatabase(database).getPool().query(
      `SELECT summary, turn_count, updated_at
       FROM sessions WHERE id = $1`,
      ['legacy-session'],
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].summary, null);
    assert.equal(result.rows[0].turn_count, 0);
    assert.ok(result.rows[0].updated_at);
  });

  it('records every baseline migration with immutable checksums', async () => {
    const result = await requireDatabase(database).getPool().query(
      `SELECT migration_id, checksum, provider
       FROM csm_schema_migrations ORDER BY migration_id`,
    );
    assert.equal(result.rows.length, 21);
    for (const row of result.rows) {
      assert.match(row.checksum, /^[a-f0-9]{64}$/);
      assert.equal(row.provider, 'postgres');
    }
  });

  it('supports runtime writes after the upgrade', async () => {
    const manager = new MemoryManager(requireDatabase(database), new EmbeddingGenerator(config));
    const saved = await manager.saveMemory({
      sessionId: 'legacy-session',
      content: 'Migration preserved the legacy session and enabled current writes.',
      type: 'lesson',
      source: 'manual',
    });
    assert.ok(saved.id > 0);
  });

  it('supported matrix: replays csm-postgres-v1 without duplicating history', async () => {
    await requireDatabase(database).close();
    database = new Database(config);
    await database.connect();
    const result = await requireDatabase(database).getPool().query(
      'SELECT COUNT(*)::int AS count FROM csm_schema_migrations',
    );
    assert.equal(result.rows[0].count, 21);
  });

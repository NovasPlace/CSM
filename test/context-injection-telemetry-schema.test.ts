import assert from 'node:assert/strict';
import { it, describe, before, after, beforeEach } from 'node:test';
import { mkdirSync, rmSync } from 'node:fs';
import { Database } from '../src/database.js';
import { initializeContextInjectionTelemetrySchema } from '../src/schema/context-injection-telemetry-schema.js';
import { SQLITE_MIGRATION_IDS } from '../src/schema/index.js';
import { artifactsFor } from '../src/schema/migration-artifacts.js';
import type { DatabasePool, PluginConfig } from '../src/types.js';

const PG_URL = process.env.CSM_DATABASE_URL ?? '';
const SQLITE_DIR = '.tmp/sqlite-telemetry';
const SQLITE_PATH = `${SQLITE_DIR}/schema-test.sqlite`;

function createSqliteConfig(): PluginConfig {
  return {
    databaseUrl: SQLITE_PATH,
    databaseProvider: 'sqlite',
    sqlitePath: SQLITE_PATH,
    embeddingModel: 'nomic-embed-text',
    embeddingApiUrl: 'http://localhost:11434',
  } as PluginConfig;
}

describe('Context injection telemetry schema - SQLite', () => {
  let db: Database;
  let pool: DatabasePool;

  before(() => {
    try { mkdirSync(SQLITE_DIR, { recursive: true }); } catch { /* exists */ }
    try { rmSync(SQLITE_PATH); } catch { /* not exists */ }
    try { rmSync(`${SQLITE_PATH}-wal`); } catch { /* not exists */ }
    try { rmSync(`${SQLITE_PATH}-shm`); } catch { /* not exists */ }
  });

  beforeEach(async () => {
    try { rmSync(SQLITE_PATH); } catch { /* not exists */ }
    db = new Database(createSqliteConfig());
    await db.connect();
    pool = db.getPool();
  });

  after(async () => {
    try { await db?.disconnect(); } catch { /* closed */ }
  });

  it('fresh migration: tables exist after schema init', async () => {
    const tables = await pool.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'context_injection%' ORDER BY name`,
    );
    const names = tables.rows.map((r: Record<string, unknown>) => r.name);
    assert.ok(names.includes('context_injection_events'));
    assert.ok(names.includes('context_injection_items'));
  });

  it('direct-DDL idempotency: running DDL twice does not throw', async () => {
    await initializeContextInjectionTelemetrySchema(pool);
    await initializeContextInjectionTelemetrySchema(pool);
    const tables = await pool.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'context_injection%'`,
    );
    assert.equal(tables.rows.length, 2);
  });

  it('upgrade migration: migration runner records the new migration id', async () => {
    const migrations = await pool.query('SELECT migration_id FROM csm_schema_migrations ORDER BY migration_id');
    const ids = migrations.rows.map((r: Record<string, unknown>) => r.migration_id);
    assert.ok(ids.includes('20260712-025-sqlite-context-injection-telemetry'));
  });

  it('migration-runner idempotency: re-running does not duplicate', async () => {
    const before = await pool.query('SELECT COUNT(*) as cnt FROM csm_schema_migrations');
    await db.disconnect();
    db = new Database(createSqliteConfig());
    await db.connect();
    pool = db.getPool();
    const after = await pool.query('SELECT COUNT(*) as cnt FROM csm_schema_migrations');
    assert.equal(Number(after.rows[0].cnt), Number(before.rows[0].cnt));
  });

  it('CHECK: injection_kind accepts valid values', async () => {
    const kinds = ['reentry', 'onboarding', 'context_brief', 'advisory'];
    for (const kind of kinds) {
      await pool.query(
        `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, builder_version, config_hash)
         VALUES ('test-kind-${kind}', 's1', '${kind}', 'production', 'injected', 'v1', 'h1')`,
      );
    }
    const rows = await pool.query(`SELECT injection_kind FROM context_injection_events WHERE idempotency_key LIKE 'test-kind-%'`);
    assert.equal(rows.rows.length, 4);
  });

  it('CHECK: injection_kind rejects invalid value', async () => {
    await assert.rejects(
      pool.query(
        `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, builder_version, config_hash)
         VALUES ('test-bad-kind', 's1', 'invalid', 'production', 'injected', 'v1', 'h1')`,
      ),
    );
  });

  it('CHECK: environment accepts valid values', async () => {
    for (const env of ['production', 'fixture', 'benchmark']) {
      await pool.query(
        `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, builder_version, config_hash)
         VALUES ('test-env-${env}', 's1', 'reentry', '${env}', 'injected', 'v1', 'h1')`,
      );
    }
    const rows = await pool.query(`SELECT environment FROM context_injection_events WHERE idempotency_key LIKE 'test-env-%'`);
    assert.equal(rows.rows.length, 3);
  });

  it('CHECK: environment rejects invalid value', async () => {
    await assert.rejects(
      pool.query(
        `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, builder_version, config_hash)
         VALUES ('test-bad-env', 's1', 'reentry', 'staging', 'injected', 'v1', 'h1')`,
      ),
    );
  });

  it('CHECK: status accepts valid values', async () => {
    for (const st of ['injected', 'skipped', 'failed']) {
      await pool.query(
        `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, builder_version, config_hash)
         VALUES ('test-status-${st}', 's1', 'reentry', 'production', '${st}', 'v1', 'h1')`,
      );
    }
    const rows = await pool.query(`SELECT status FROM context_injection_events WHERE idempotency_key LIKE 'test-status-%'`);
    assert.equal(rows.rows.length, 3);
  });

  it('CHECK: status rejects invalid value', async () => {
    await assert.rejects(
      pool.query(
        `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, builder_version, config_hash)
         VALUES ('test-bad-status', 's1', 'reentry', 'production', 'pending', 'v1', 'h1')`,
      ),
    );
  });

  it('CHECK: trim_level accepts valid values', async () => {
    for (const tl of ['none', 'soft', 'aggressive']) {
      await pool.query(
        `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, trim_level, builder_version, config_hash)
         VALUES ('test-trim-${tl}', 's1', 'reentry', 'production', 'injected', '${tl}', 'v1', 'h1')`,
      );
    }
    const rows = await pool.query(`SELECT trim_level FROM context_injection_events WHERE idempotency_key LIKE 'test-trim-%'`);
    assert.equal(rows.rows.length, 3);
  });

  it('CHECK: trim_level rejects invalid value', async () => {
    await assert.rejects(
      pool.query(
        `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, trim_level, builder_version, config_hash)
         VALUES ('test-bad-trim', 's1', 'reentry', 'production', 'injected', 'extreme', 'v1', 'h1')`,
      ),
    );
  });

  it('CHECK: source_kind accepts valid values on items', async () => {
    const ev = await pool.query(
      `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, builder_version, config_hash)
       VALUES ('test-src-kind', 's1', 'reentry', 'production', 'injected', 'v1', 'h1') RETURNING id`,
    );
    const eventId = ev.rows[0].id as number;
    const kinds = ['memory', 'document_section', 'derived_state'];
    for (let i = 0; i < kinds.length; i++) {
      await pool.query(
        `INSERT INTO context_injection_items (injection_event_id, layer_name, source_kind, source_id, position, disposition, provenance_granularity)
         VALUES (${eventId}, 'layer${i}', '${kinds[i]}', 'src${i}', ${i}, 'injected', 'item')`,
      );
    }
    const rows = await pool.query(`SELECT source_kind FROM context_injection_items WHERE injection_event_id = ${eventId}`);
    assert.equal(rows.rows.length, 3);
  });

  it('CHECK: source_kind rejects invalid value on items', async () => {
    const ev = await pool.query(
      `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, builder_version, config_hash)
       VALUES ('test-bad-src', 's1', 'reentry', 'production', 'injected', 'v1', 'h1') RETURNING id`,
    );
    const eventId = ev.rows[0].id as number;
    await assert.rejects(
      pool.query(
        `INSERT INTO context_injection_items (injection_event_id, layer_name, source_kind, source_id, position, disposition, provenance_granularity)
         VALUES (${eventId}, 'identity', 'invalid', 'src1', 0, 'injected', 'item')`,
      ),
    );
  });

  it('CHECK: disposition accepts valid values on items', async () => {
    const ev = await pool.query(
      `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, builder_version, config_hash)
       VALUES ('test-disp', 's1', 'reentry', 'production', 'injected', 'v1', 'h1') RETURNING id`,
    );
    const eventId = ev.rows[0].id as number;
    const disps = ['injected', 'trimmed', 'omitted'];
    for (let i = 0; i < disps.length; i++) {
      await pool.query(
        `INSERT INTO context_injection_items (injection_event_id, layer_name, source_kind, source_id, position, disposition, provenance_granularity)
         VALUES (${eventId}, 'layer${i}', 'memory', 'src${i}', ${i}, '${disps[i]}', 'item')`,
      );
    }
    const rows = await pool.query(`SELECT disposition FROM context_injection_items WHERE injection_event_id = ${eventId}`);
    assert.equal(rows.rows.length, 3);
  });

  it('CHECK: disposition rejects invalid value on items', async () => {
    const ev = await pool.query(
      `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, builder_version, config_hash)
       VALUES ('test-bad-disp', 's1', 'reentry', 'production', 'injected', 'v1', 'h1') RETURNING id`,
    );
    const eventId = ev.rows[0].id as number;
    await assert.rejects(
      pool.query(
        `INSERT INTO context_injection_items (injection_event_id, layer_name, source_kind, source_id, position, disposition, provenance_granularity)
         VALUES (${eventId}, 'identity', 'memory', 'src1', 0, 'rejected', 'item')`,
      ),
    );
  });

  it('CHECK: selection_reason_code accepts valid values on items', async () => {
    const codes = ['importance_rank', 'recent_session', 'explicit_preference', 'active_goal', 'budget_trim', 'layer_budget_exhausted', 'filter_rejection', 'empty_source'];
    const ev = await pool.query(
      `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, builder_version, config_hash)
       VALUES ('test-reason', 's1', 'reentry', 'production', 'injected', 'v1', 'h1') RETURNING id`,
    );
    const eventId = ev.rows[0].id as number;
    for (let i = 0; i < codes.length; i++) {
      await pool.query(
        `INSERT INTO context_injection_items (injection_event_id, layer_name, source_kind, source_id, position, disposition, provenance_granularity, selection_reason_code)
         VALUES (${eventId}, 'layer${i}', 'memory', 'src${i}', ${i}, 'injected', 'item', '${codes[i]}')`,
      );
    }
    const rows = await pool.query(`SELECT selection_reason_code FROM context_injection_items WHERE injection_event_id = ${eventId}`);
    assert.equal(rows.rows.length, codes.length);
  });

  it('CHECK: selection_reason_code rejects invalid value on items', async () => {
    const ev = await pool.query(
      `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, builder_version, config_hash)
       VALUES ('test-bad-reason', 's1', 'reentry', 'production', 'injected', 'v1', 'h1') RETURNING id`,
    );
    const eventId = ev.rows[0].id as number;
    await assert.rejects(
      pool.query(
        `INSERT INTO context_injection_items (injection_event_id, layer_name, source_kind, source_id, position, disposition, provenance_granularity, selection_reason_code)
         VALUES (${eventId}, 'identity', 'memory', 'src1', 0, 'injected', 'item', 'random')`,
      ),
    );
  });

  it('CHECK: provenance_granularity accepts valid values on items', async () => {
    const ev = await pool.query(
      `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, builder_version, config_hash)
       VALUES ('test-gran', 's1', 'reentry', 'production', 'injected', 'v1', 'h1') RETURNING id`,
    );
    const eventId = ev.rows[0].id as number;
    for (let i = 0; i < 2; i++) {
      const g = ['item', 'layer'][i];
      await pool.query(
        `INSERT INTO context_injection_items (injection_event_id, layer_name, source_kind, source_id, position, disposition, provenance_granularity)
         VALUES (${eventId}, 'layer_${g}', 'memory', 'src_${g}', ${i}, 'injected', '${g}')`,
      );
    }
    const rows = await pool.query(`SELECT provenance_granularity FROM context_injection_items WHERE injection_event_id = ${eventId}`);
    assert.equal(rows.rows.length, 2);
  });

  it('CHECK: provenance_granularity rejects invalid value on items', async () => {
    const ev = await pool.query(
      `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, builder_version, config_hash)
       VALUES ('test-bad-gran', 's1', 'reentry', 'production', 'injected', 'v1', 'h1') RETURNING id`,
    );
    const eventId = ev.rows[0].id as number;
    await assert.rejects(
      pool.query(
        `INSERT INTO context_injection_items (injection_event_id, layer_name, source_kind, source_id, position, disposition, provenance_granularity)
         VALUES (${eventId}, 'identity', 'memory', 'src1', 0, 'injected', 'aggregate')`,
      ),
    );
  });

  it('idempotency_key uniqueness: duplicate key is rejected', async () => {
    await pool.query(
      `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, builder_version, config_hash)
       VALUES ('unique-test-1', 's1', 'reentry', 'production', 'injected', 'v1', 'h1')`,
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, builder_version, config_hash)
         VALUES ('unique-test-1', 's2', 'reentry', 'production', 'injected', 'v1', 'h1')`,
      ),
    );
  });

  it('memory_id FK: references memories(id) with ON DELETE SET NULL', async () => {
    const mem = await pool.query(
      `INSERT INTO memories (session_id, memory_type, content, importance) VALUES ('s-fk', 'conversation', 'test memory', 0.5) RETURNING id`,
    );
    const memoryId = mem.rows[0].id;
    const ev = await pool.query(
      `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, builder_version, config_hash)
       VALUES ('fk-test', 's1', 'reentry', 'production', 'injected', 'v1', 'h1') RETURNING id`,
    );
    const eventId = ev.rows[0].id as number;
    await pool.query(
      `INSERT INTO context_injection_items (injection_event_id, layer_name, source_kind, source_id, memory_id, position, disposition, provenance_granularity)
       VALUES (${eventId}, 'identity', 'memory', 'src1', ${memoryId}, 0, 'injected', 'item')`,
    );
    const before = await pool.query(`SELECT memory_id FROM context_injection_items WHERE injection_event_id = ${eventId}`);
    assert.equal(before.rows[0].memory_id, memoryId);

    await pool.query(`DELETE FROM memories WHERE id = ${memoryId}`);
    const after = await pool.query(`SELECT memory_id FROM context_injection_items WHERE injection_event_id = ${eventId}`);
    assert.equal(after.rows[0].memory_id, null);
  });

  it('FK cascade: deleting an event deletes its items', async () => {
    const ev = await pool.query(
      `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, builder_version, config_hash)
       VALUES ('cascade-test', 's1', 'reentry', 'production', 'injected', 'v1', 'h1') RETURNING id`,
    );
    const eventId = ev.rows[0].id as number;
    await pool.query(
      `INSERT INTO context_injection_items (injection_event_id, layer_name, source_kind, source_id, position, disposition, provenance_granularity)
       VALUES (${eventId}, 'identity', 'memory', 'src1', 0, 'injected', 'item')`,
    );
    await pool.query(`DELETE FROM context_injection_events WHERE id = ${eventId}`);
    const items = await pool.query(`SELECT id FROM context_injection_items WHERE injection_event_id = ${eventId}`);
    assert.equal(items.rows.length, 0);
  });

  it('UNIQUE (injection_event_id, layer_name, position): duplicate position rejected', async () => {
    const ev = await pool.query(
      `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, builder_version, config_hash)
       VALUES ('uniq-pos-test', 's1', 'reentry', 'production', 'injected', 'v1', 'h1') RETURNING id`,
    );
    const eventId = ev.rows[0].id as number;
    await pool.query(
      `INSERT INTO context_injection_items (injection_event_id, layer_name, source_kind, source_id, position, disposition, provenance_granularity)
       VALUES (${eventId}, 'goals', 'memory', 'src1', 0, 'injected', 'item')`,
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO context_injection_items (injection_event_id, layer_name, source_kind, source_id, position, disposition, provenance_granularity)
         VALUES (${eventId}, 'goals', 'memory', 'src2', 0, 'injected', 'item')`,
      ),
    );
  });

  it('artifact registration: both migration IDs have artifacts', () => {
    const pgArtifacts = artifactsFor('20260712-024-context-injection-telemetry');
    assert.ok(pgArtifacts.length >= 1);
    assert.ok(pgArtifacts[0].includes('context-injection-telemetry-schema.ts'));

    const sqliteArtifacts = artifactsFor('20260712-025-sqlite-context-injection-telemetry');
    assert.ok(sqliteArtifacts.length >= 1);
    assert.ok(sqliteArtifacts[0].includes('context-injection-telemetry-schema.ts'));
  });

  it('SQLITE_MIGRATION_IDS includes the new migration', () => {
    assert.ok(SQLITE_MIGRATION_IDS.includes('20260712-025-sqlite-context-injection-telemetry'));
  });
});

describe('Context injection telemetry schema - PostgreSQL', { skip: !PG_URL }, () => {
  let pool: DatabasePool;

  before(async () => {
    const { DEFAULT_CONFIG } = await import('../src/config.js');
    const db = new Database(DEFAULT_CONFIG);
    await db.connect();
    pool = db.getPool();
    await pool.query(`DELETE FROM context_injection_items WHERE injection_event_id IN (SELECT id FROM context_injection_events WHERE idempotency_key LIKE 'pg-%')`);
    await pool.query(`DELETE FROM context_injection_events WHERE idempotency_key LIKE 'pg-%'`);
    await pool.query(`DELETE FROM memories WHERE session_id = 's-fk'`);
    await pool.query(`DELETE FROM sessions WHERE id = 's-fk'`);
  });

  after(async () => {
    try { await pool.close(); } catch { /* closed */ }
  });

  it('fresh migration: tables exist after DDL', async () => {
    const tables = await pool.query(
      `SELECT tablename FROM pg_tables WHERE tablename LIKE 'context_injection%' ORDER BY tablename`,
    );
    const names = tables.rows.map((r: Record<string, unknown>) => r.tablename);
    assert.ok(names.includes('context_injection_events'));
    assert.ok(names.includes('context_injection_items'));
  });

  it('direct-DDL idempotency: running DDL twice does not throw', async () => {
    await initializeContextInjectionTelemetrySchema(pool);
    await initializeContextInjectionTelemetrySchema(pool);
    const tables = await pool.query(
      `SELECT tablename FROM pg_tables WHERE tablename LIKE 'context_injection%'`,
    );
    assert.equal(tables.rows.length, 2);
  });

  it('CHECK: injection_kind rejects invalid value', async () => {
    await assert.rejects(
      pool.query(
        `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, builder_version, config_hash)
         VALUES ('pg-bad-kind', 's1', 'invalid', 'production', 'injected', 'v1', 'h1')`,
      ),
    );
  });

  it('CHECK: environment rejects invalid value', async () => {
    await assert.rejects(
      pool.query(
        `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, builder_version, config_hash)
         VALUES ('pg-bad-env', 's1', 'reentry', 'staging', 'injected', 'v1', 'h1')`,
      ),
    );
  });

  it('CHECK: status rejects invalid value', async () => {
    await assert.rejects(
      pool.query(
        `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, builder_version, config_hash)
         VALUES ('pg-bad-status', 's1', 'reentry', 'production', 'pending', 'v1', 'h1')`,
      ),
    );
  });

  it('idempotency_key uniqueness: duplicate key is rejected', async () => {
    await pool.query(
      `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, builder_version, config_hash)
       VALUES ('pg-unique-1', 's1', 'reentry', 'production', 'injected', 'v1', 'h1')`,
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, builder_version, config_hash)
         VALUES ('pg-unique-1', 's2', 'reentry', 'production', 'injected', 'v1', 'h1')`,
      ),
    );
  });

  it('memory_id FK: ON DELETE SET NULL', async () => {
    await pool.query(
      `INSERT INTO sessions (id, project_id) VALUES ('s-fk', 'test-project') ON CONFLICT DO NOTHING`,
    );
    const mem = await pool.query(
      `INSERT INTO memories (session_id, memory_type, content, importance) VALUES ('s-fk', 'conversation', 'test', 0.5) RETURNING id`,
    );
    const memoryId = mem.rows[0].id;
    const ev = await pool.query(
      `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, builder_version, config_hash)
       VALUES ('pg-fk-test', 's1', 'reentry', 'production', 'injected', 'v1', 'h1') RETURNING id`,
    );
    const eventId = ev.rows[0].id;
    await pool.query(
      `INSERT INTO context_injection_items (injection_event_id, layer_name, source_kind, source_id, memory_id, position, disposition, provenance_granularity)
       VALUES ($1, 'identity', 'memory', 'src1', $2, 0, 'injected', 'item')`,
      [eventId, memoryId],
    );
    await pool.query(`DELETE FROM memories WHERE id = $1`, [memoryId]);
    const after = await pool.query(`SELECT memory_id FROM context_injection_items WHERE injection_event_id = $1`, [eventId]);
    assert.equal(after.rows[0].memory_id, null);
  });

  it('FK cascade: deleting an event deletes its items', async () => {
    const ev = await pool.query(
      `INSERT INTO context_injection_events (idempotency_key, session_id, injection_kind, environment, status, builder_version, config_hash)
       VALUES ('pg-cascade-test', 's1', 'reentry', 'production', 'injected', 'v1', 'h1') RETURNING id`,
    );
    const eventId = ev.rows[0].id;
    await pool.query(
      `INSERT INTO context_injection_items (injection_event_id, layer_name, source_kind, source_id, position, disposition, provenance_granularity)
       VALUES ($1, 'identity', 'memory', 'src1', 0, 'injected', 'item')`,
      [eventId],
    );
    await pool.query(`DELETE FROM context_injection_events WHERE id = $1`, [eventId]);
    const items = await pool.query(`SELECT id FROM context_injection_items WHERE injection_event_id = $1`, [eventId]);
    assert.equal(items.rows.length, 0);
  });

  it('logical schema parity: column names match between PG and SQLite', async () => {
    const pgCols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'context_injection_events' ORDER BY column_name`,
    );
    const pgNames = pgCols.rows.map((r: Record<string, unknown>) => r.column_name);

    const sqliteConfig = createSqliteConfig();
    try { mkdirSync(SQLITE_DIR, { recursive: true }); } catch { /* exists */ }
    try { rmSync(`${SQLITE_DIR}/parity.sqlite`); } catch { /* not exists */ }
    (sqliteConfig as { sqlitePath: string }).sqlitePath = `${SQLITE_DIR}/parity.sqlite`;
    (sqliteConfig as { databaseUrl: string }).databaseUrl = `${SQLITE_DIR}/parity.sqlite`;
    const sqliteDb = new Database(sqliteConfig);
    await sqliteDb.connect();
    const sqlitePool = sqliteDb.getPool();
    const sqliteCols = await sqlitePool.query(`PRAGMA table_info(context_injection_events)`);
    const sqliteNames = sqliteCols.rows.map((r: Record<string, unknown>) => r.name).sort();
    await sqliteDb.disconnect();

    assert.deepEqual(pgNames, sqliteNames);
  });
});

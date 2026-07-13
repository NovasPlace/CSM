import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { Database } from '../dist/database.js';
import { COMPACTION_METRICS_COLUMNS } from '../dist/schema/sqlite/compaction-metrics.js';
import type { PluginConfig } from '../dist/types.js';

describe('Phase 10C1 — SQLite compaction_metrics migration', () => {
  const tmpDir = '.tmp/sqlite-compaction-migration';
  const dbPath = `${tmpDir}/csm-test.sqlite`;

  beforeEach(() => {
    try { mkdirSync(tmpDir, { recursive: true }); } catch { /* exists */ }
    try { rmSync(dbPath); } catch { /* not exists */ }
    try { rmSync(`${dbPath}-wal`); } catch { /* not exists */ }
    try { rmSync(`${dbPath}-shm`); } catch { /* not exists */ }
  });

  afterEach(() => {
    try { rmSync(dbPath); } catch { /* not exists */ }
    try { rmSync(`${dbPath}-wal`); } catch { /* not exists */ }
    try { rmSync(`${dbPath}-shm`); } catch { /* not exists */ }
    try { rmSync(tmpDir); } catch { /* not exists */ }
  });

  function makeConfig(): PluginConfig {
    return {
      databaseUrl: dbPath,
      databaseProvider: 'sqlite',
      sqlitePath: dbPath,
      embeddingModel: 'nomic-embed-text',
      embeddingApiUrl: 'http://localhost:11434',
    };
  }

  it('fresh bootstrap creates compaction_metrics table with all canonical columns', async () => {
    const db = new Database(makeConfig());
    await db.connect();
    const pool = db.getPool();

    const tableResult = await pool.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='compaction_metrics'",
    );
    assert.equal(tableResult.rows.length, 1);

    const colResult = await pool.query('PRAGMA table_info(compaction_metrics)');
    const columnNames = (colResult.rows as { name: string }[]).map((r) => r.name);
    for (const expected of COMPACTION_METRICS_COLUMNS) {
      assert.ok(columnNames.includes(expected), `missing column: ${expected}`);
    }

    const idxResult = await pool.query(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='compaction_metrics'",
    );
    const indexNames = (idxResult.rows as { name: string }[]).map((r) => r.name);
    assert.ok(indexNames.includes('idx_compaction_metrics_session'));
    assert.ok(indexNames.includes('idx_compaction_metrics_created'));

    await db.close();
  });

  it('fresh bootstrap creates compaction_metrics with ISO-8601 timestamp default', async () => {
    const db = new Database(makeConfig());
    await db.connect();
    const pool = db.getPool();

    const sqlResult = await pool.query(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='compaction_metrics'",
    );
    const tableSql = (sqlResult.rows[0] as { sql: string }).sql;
    assert.ok(
      tableSql.includes("strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"),
      'created_at default must use ISO-8601 strftime format',
    );

    await db.close();
  });

  it('legacy database without compaction_metrics receives table through migration', async () => {
    const config = makeConfig();
    const legacy = new Database(config);
    await legacy.connect();
    await legacy.getPool().query('DROP TABLE compaction_metrics');
    await legacy.getPool().query(
      'DELETE FROM csm_schema_migrations WHERE migration_id = $1',
      ['20260711-024-sqlite-compaction-metrics'],
    );
    await legacy.close();

    const upgraded = new Database(config);
    await upgraded.connect();
    const pool = upgraded.getPool();

    const tableResult = await pool.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='compaction_metrics'",
    );
    assert.equal(tableResult.rows.length, 1);

    const colResult = await pool.query('PRAGMA table_info(compaction_metrics)');
    const columnNames = (colResult.rows as { name: string }[]).map((r) => r.name);
    assert.equal(columnNames.length, COMPACTION_METRICS_COLUMNS.length);

    await upgraded.close();
  });

  it('migration is idempotent — running twice produces no error or duplicate columns', async () => {
    const db = new Database(makeConfig());
    await db.connect();
    const pool = db.getPool();

    const colResultBefore = await pool.query('PRAGMA table_info(compaction_metrics)');
    const colsBefore = (colResultBefore.rows as { name: string }[]).map((r) => r.name);

    await pool.query(
      'DELETE FROM csm_schema_migrations WHERE migration_id = $1',
      ['20260711-024-sqlite-compaction-metrics'],
    );
    await db.close();

    const upgraded = new Database(makeConfig());
    await upgraded.connect();

    const colResultAfter = await upgraded.getPool().query('PRAGMA table_info(compaction_metrics)');
    const colsAfter = (colResultAfter.rows as { name: string }[]).map((r) => r.name);
    assert.deepEqual(colsAfter, colsBefore);

    await upgraded.close();
  });

  it('repair an incomplete table — existing valid rows survive with defaults for missing columns', async () => {
    const config = makeConfig();
    const legacy = new Database(config);
    await legacy.connect();
    const legacyPool = legacy.getPool();

    await legacyPool.query('DROP TABLE compaction_metrics');
    await legacyPool.query(`
      CREATE TABLE compaction_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        total_tool_parts INTEGER NOT NULL DEFAULT 0,
        compacted_parts INTEGER NOT NULL DEFAULT 0,
        before_tokens INTEGER NOT NULL DEFAULT 0,
        after_tokens INTEGER NOT NULL DEFAULT 0,
        tokens_saved INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'compressed',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await legacyPool.query(
      `INSERT INTO compaction_metrics (id, session_id, total_tool_parts, compacted_parts, before_tokens, after_tokens, tokens_saved, status, created_at)
       VALUES (1, 'repair-test', 10, 5, 1000, 700, 300, 'compressed', '2026-07-11T14:30:00.000Z')`,
    );
    await legacyPool.query(
      `INSERT INTO compaction_metrics (id, session_id, total_tool_parts, compacted_parts, before_tokens, after_tokens, tokens_saved, status, created_at)
       VALUES (2, 'repair-test', 8, 3, 600, 400, 200, 'skipped_under_budget', '2026-07-11T15:00:00.000Z')`,
    );
    await legacyPool.query(
      'DELETE FROM csm_schema_migrations WHERE migration_id = $1',
      ['20260711-024-sqlite-compaction-metrics'],
    );
    await legacy.close();

    const upgraded = new Database(config);
    await upgraded.connect();
    const pool = upgraded.getPool();

    const colResult = await pool.query('PRAGMA table_info(compaction_metrics)');
    const columnNames = (colResult.rows as { name: string }[]).map((r) => r.name);
    for (const expected of COMPACTION_METRICS_COLUMNS) {
      assert.ok(columnNames.includes(expected), `repair missing column: ${expected}`);
    }

    const rows = await pool.query('SELECT * FROM compaction_metrics ORDER BY id');
    assert.equal(rows.rows.length, 2);
    const row1 = rows.rows[0] as Record<string, unknown>;
    assert.equal(row1.session_id, 'repair-test');
    assert.equal(row1.total_tool_parts, 10);
    assert.equal(row1.compacted_parts, 5);
    assert.equal(row1.before_tokens, 1000);
    assert.equal(row1.after_tokens, 700);
    assert.equal(row1.tokens_saved, 300);
    assert.equal(row1.before_chars, 0);
    assert.equal(row1.after_chars, 0);
    assert.equal(row1.skipped_parts, 0);

    await upgraded.close();
  });

  it('sqlite_version() is logged and window functions are supported', async () => {
    const db = new Database(makeConfig());
    await db.connect();
    const pool = db.getPool();

    const versionResult = await pool.query('SELECT sqlite_version() AS version');
    const version = (versionResult.rows[0] as { version: string }).version;
    assert.ok(version, `sqlite_version() returned: ${version}`);

    const windowResult = await pool.query(
      'SELECT ROW_NUMBER() OVER (ORDER BY value) AS rn FROM (SELECT 1 AS value)',
    );
    assert.equal((windowResult.rows[0] as { rn: number }).rn, 1);

    await db.close();
  });
});

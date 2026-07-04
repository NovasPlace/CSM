import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createSqlitePool } from '../src/db/sqlite-pool.js';

const TMP_DIR = join(process.cwd(), '.tmp');
const DB_PATH = join(TMP_DIR, 'test-sqlite-pool.db');

describe('SqlitePool', () => {
  beforeEach(() => {
    try { mkdirSync(TMP_DIR, { recursive: true }); } catch { /* exists */ }
    try { rmSync(DB_PATH); } catch { /* not exists */ }
    try { rmSync(DB_PATH + '-wal'); } catch { /* not exists */ }
    try { rmSync(DB_PATH + '-shm'); } catch { /* not exists */ }
  });

  afterEach(() => {
    try { rmSync(DB_PATH); } catch { /* not exists */ }
    try { rmSync(DB_PATH + '-wal'); } catch { /* not exists */ }
    try { rmSync(DB_PATH + '-shm'); } catch { /* not exists */ }
  });

  it('creates a pool and connects to an in-memory database', async () => {
    const pool = await createSqlitePool(':memory:');
    const result = await pool.query('SELECT 1 AS val');
    assert.equal(result.rows.length, 1);
    assert.equal((result.rows[0] as { val: number }).val, 1);
    await pool.end();
  });

  it('translates $N placeholders to ?N', async () => {
    const pool = await createSqlitePool(':memory:');
    await pool.query('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    await pool.query('INSERT INTO t (name) VALUES ($1)', ['alice']);
    await pool.query('INSERT INTO t (name) VALUES ($1)', ['bob']);
    const result = await pool.query('SELECT * FROM t WHERE name = $1', ['alice']);
    assert.equal(result.rows.length, 1);
    assert.equal((result.rows[0] as { name: string }).name, 'alice');
    await pool.end();
  });

  it('strips ::type casts from SQL', async () => {
    const pool = await createSqlitePool(':memory:');
    await pool.query('CREATE TABLE t (id INTEGER PRIMARY KEY, score REAL)');
    await pool.query('INSERT INTO t (score) VALUES ($1)', [0.5]);
    const result = await pool.query('SELECT score::float AS s FROM t WHERE id = $1::int', [1]);
    assert.equal(result.rows.length, 1);
    assert.equal((result.rows[0] as { s: number }).s, 0.5);
    await pool.end();
  });

  it('returns rowCount for INSERT/UPDATE/DELETE', async () => {
    const pool = await createSqlitePool(':memory:');
    await pool.query('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    const insertResult = await pool.query('INSERT INTO t (name) VALUES ($1)', ['alice']);
    assert.equal(insertResult.rowCount, 1);
    assert.equal(insertResult.rows.length, 0);

    const updateResult = await pool.query('UPDATE t SET name = $1 WHERE name = $2', ['ALICE', 'alice']);
    assert.equal(updateResult.rowCount, 1);

    const deleteResult = await pool.query('DELETE FROM t WHERE name = $1', ['ALICE']);
    assert.equal(deleteResult.rowCount, 1);
    await pool.end();
  });

  it('supports RETURNING clause via .all()', async () => {
    const pool = await createSqlitePool(':memory:');
    await pool.query('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    const result = await pool.query('INSERT INTO t (name) VALUES ($1) RETURNING *', ['alice']);
    assert.equal(result.rows.length, 1);
    assert.equal((result.rows[0] as { name: string }).name, 'alice');
    await pool.end();
  });

  it('supports transactions via connect/BEGIN/COMMIT', async () => {
    const pool = await createSqlitePool(':memory:');
    await pool.query('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO t (name) VALUES ($1)', ['txn1']);
      await client.query('INSERT INTO t (name) VALUES ($1)', ['txn2']);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const result = await pool.query('SELECT COUNT(*)::int AS cnt FROM t');
    assert.equal((result.rows[0] as { cnt: number }).cnt, 2);
    await pool.end();
  });

  it('rolls back on error', async () => {
    const pool = await createSqlitePool(':memory:');
    await pool.query('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');

    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO t (name) VALUES ($1)', ['before']);
        throw new Error('simulated failure');
      } finally {
        try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
        client.release();
      }
    } catch { /* expected */ }

    const result = await pool.query('SELECT COUNT(*)::int AS cnt FROM t');
    assert.equal((result.rows[0] as { cnt: number }).cnt, 0);
    await pool.end();
  });

  it('creates a persistent file-based database', async () => {
    const pool = await createSqlitePool(DB_PATH);
    await pool.query('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    await pool.query('INSERT INTO t (name) VALUES ($1)', ['persistent']);
    await pool.end();

    const pool2 = await createSqlitePool(DB_PATH);
    const result = await pool2.query('SELECT * FROM t');
    assert.equal(result.rows.length, 1);
    assert.equal((result.rows[0] as { name: string }).name, 'persistent');
    await pool2.end();
  });

  it('strips array casts like ::text[] and ::bigint[]', async () => {
    const pool = await createSqlitePool(':memory:');
    await pool.query('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
    await pool.query("INSERT INTO t (val) VALUES ($1)", ['["a","b"]']);
    const result = await pool.query('SELECT val FROM t WHERE id = $1::bigint', [1]);
    assert.equal(result.rows.length, 1);
    await pool.end();
  });
});

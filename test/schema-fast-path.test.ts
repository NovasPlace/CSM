import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initializeAllSchemas, SCHEMA_VERSION } from '../dist/schema/index.js';

type Result = { rows: unknown[]; rowCount: number };

function makePool(onVersionSelect: () => Result) {
  const queries: string[] = [];
  const pool = {
    queries,
    query: async (text: string, _params?: unknown[]): Promise<Result> => {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      queries.push(sql);
      if (/^SELECT version FROM csm_schema_state/i.test(sql)) return onVersionSelect();
      return { rows: [], rowCount: 0 };
    },
  };
  return pool;
}

const fakeDatabase = (pool: unknown) => ({
  getPool: () => pool,
  getProvider: () => 'postgres',
  dialect: 'postgres',
}) as never;

describe('schema init — fast path', () => {
  it('skips every step when the recorded version matches', async () => {
    const pool = makePool(() => ({ rows: [{ version: SCHEMA_VERSION }], rowCount: 1 }));
    await initializeAllSchemas(fakeDatabase(pool));
    assert.equal(
      pool.queries.length,
      1,
      `expected exactly 1 round-trip (the version SELECT), got ${pool.queries.length}`,
    );
  });

  it('runs a full initialization when the marker table is absent, then records the version', async () => {
    const pool = makePool(() => {
      throw new Error('relation "csm_schema_state" does not exist');
    });
    await initializeAllSchemas(fakeDatabase(pool));
    assert.ok(pool.queries.length > 100, `expected a full init, got ${pool.queries.length} queries`);
    assert.ok(
      pool.queries.some((q) => /^CREATE TABLE IF NOT EXISTS csm_schema_state/i.test(q)),
      'expected the marker table to be created',
    );
    assert.ok(
      pool.queries.some((q) => /^INSERT INTO csm_schema_state/i.test(q)),
      'expected the schema version to be recorded',
    );
  });

  it('re-initializes when the recorded version is stale', async () => {
    const pool = makePool(() => ({ rows: [{ version: SCHEMA_VERSION - 1 }], rowCount: 1 }));
    await initializeAllSchemas(fakeDatabase(pool));
    assert.ok(pool.queries.length > 100, `expected a full init, got ${pool.queries.length} queries`);
  });

  it('CSM_SCHEMA_FORCE_INIT=true bypasses the fast path entirely', async () => {
    process.env['CSM_SCHEMA_FORCE_INIT'] = 'true';
    try {
      const pool = makePool(() => ({ rows: [{ version: SCHEMA_VERSION }], rowCount: 1 }));
      await initializeAllSchemas(fakeDatabase(pool));
      assert.ok(pool.queries.length > 100, `expected a forced full init, got ${pool.queries.length}`);
      assert.ok(
        !pool.queries.some((q) => /^SELECT version FROM csm_schema_state/i.test(q)),
        'the version SELECT should be short-circuited when forcing',
      );
    } finally {
      delete process.env['CSM_SCHEMA_FORCE_INIT'];
    }
  });

  it('leaves the SQLite path untouched', async () => {
    const pool = makePool(() => ({ rows: [], rowCount: 0 }));
    const sqliteDb = { getPool: () => pool, getProvider: () => 'sqlite', dialect: 'sqlite' } as never;
    await initializeAllSchemas(sqliteDb);
    assert.ok(
      !pool.queries.some((q) => /csm_schema_state/i.test(q)),
      'the fast path must not touch the SQLite branch',
    );
  });
});

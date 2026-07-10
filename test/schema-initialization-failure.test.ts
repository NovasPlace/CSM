import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initializeAllSchemas } from '../dist/schema/index.js';

function databaseWithPool(query: (sql: string) => Promise<{ rows: unknown[] }>) {
  const client = { query, release() {} };
  return {
    getProvider: () => 'postgres',
    getPool: () => ({
      query,
      connect: async () => client,
      end: async () => {},
    }),
    dialect: 'pg',
  } as any;
}

describe('schema initialization failure policy', () => {
  it('fails fast with the exact schema step on non-ownership errors', async () => {
    const queries: string[] = [];
    const database = databaseWithPool(async (sql) => {
      queries.push(sql);
      if (sql.includes('CREATE EXTENSION')) throw new Error('vector extension unavailable');
      return { rows: [] };
    });

    await assert.rejects(
      () => initializeAllSchemas(database),
      /Schema step failed \(20260709-001-vector-extension\): vector extension unavailable/,
    );
    assert.ok(queries.some((sql) => sql.includes('pg_advisory_xact_lock')));
    assert.ok(queries.includes('ROLLBACK TO SAVEPOINT csm_schema_migration'));
    assert.equal(queries.at(-1), 'ROLLBACK');
    assert.ok(!queries.includes('COMMIT'));
  });

  it('fails fast on ownership-limited required migrations', async () => {
    const queries: string[] = [];
    const database = databaseWithPool(async (sql) => {
      queries.push(sql);
      if (sql.includes('CREATE EXTENSION')) {
        throw { code: '42501', message: 'must be owner of table memories' };
      }
      return { rows: [] };
    });

    await assert.rejects(
      () => initializeAllSchemas(database),
      /Schema step failed \(20260709-001-vector-extension\)/,
    );
    assert.ok(queries.includes('ROLLBACK TO SAVEPOINT csm_schema_migration'));
    assert.equal(queries.at(-1), 'ROLLBACK');
    assert.ok(!queries.includes('COMMIT'));
  });

  it('preserves migration and rollback failures in one error', async () => {
    const database = databaseWithPool(async (sql) => {
      if (sql.includes('CREATE EXTENSION')) throw new Error('migration failed');
      if (sql.startsWith('ROLLBACK TO SAVEPOINT')) throw new Error('rollback failed');
      return { rows: [] };
    });
    await assert.rejects(
      () => initializeAllSchemas(database),
      /migration failed; savepoint rollback failed: rollback failed/,
    );
  });
});

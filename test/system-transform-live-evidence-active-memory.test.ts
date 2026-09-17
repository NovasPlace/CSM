import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { injectDirectMemoryEvidence } from '../src/hooks/system-transform-live-evidence.js';

describe('direct system memory evidence lifecycle filtering', () => {
  it('uses only active memories for injected content and counts', async () => {
    const queries: string[] = [];
    const pool = {
      query: mock.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('SELECT COUNT(*) as cnt FROM memories')) {
          return { rows: [{ cnt: 0 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const ctx = {
      database: {
        dialect: 'pg',
        getPool: () => pool,
      },
    };
    const output = { system: [] as string[] };

    await injectDirectMemoryEvidence(ctx as never, output as never);

    assert.equal(output.system.length, 1);
    assert.match(output.system[0] ?? '', /records: 0/);

    const memoryQueries = queries.filter((sql) => sql.includes('FROM memories'));
    assert.equal(memoryQueries.length, 4);
    for (const sql of memoryQueries) {
      assert.match(sql, /superseded_by IS NULL/, `missing superseded filter in: ${sql}`);
      assert.match(sql, /archived_at IS NULL/, `missing archive filter in: ${sql}`);
    }
  });
});

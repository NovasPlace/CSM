import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EmbeddingBackfill } from '../dist/embedding-backfill.js';

function fakePool(rows: unknown[] = []) {
  return { query: mock.fn(() => Promise.resolve({ rows, rowCount: rows.length })) };
}

const fakeEmbeddings = {
  generate: mock.fn((_text: string) => Promise.resolve(new Array(1536).fill(0.1))),
};

function makeBackfill(pool: ReturnType<typeof fakePool>): EmbeddingBackfill {
  const fakeDb = { getPool: () => pool };
  const fakeGen = fakeEmbeddings as any;
  return new EmbeddingBackfill(fakeDb as any, fakeGen);
}

describe('EmbeddingBackfill', () => {
  it('countMissing returns count from query', async () => {
    const pool = fakePool([{ cnt: 42 }]);
    const bf = makeBackfill(pool);
    const count = await bf.countMissing();
    assert.equal(count, 42);
    assert.ok((pool.query.mock.calls[0]?.arguments[0] as string).includes('COUNT(*)'));
  });

  it('countMissing with projectId adds WHERE clause', async () => {
    const pool = fakePool([{ cnt: 7 }]);
    const bf = makeBackfill(pool);
    await bf.countMissing('proj-1');
    const sql = pool.query.mock.calls[0]?.arguments[0] as string;
    assert.ok(sql.includes('project_id = $1'));
  });

  it('backfill dry-run skips writes and returns skipped count', async () => {
    const pool = fakePool([{ cnt: 10 }]);
    const bf = makeBackfill(pool);
    const result = await bf.backfill({ dryRun: true });
    assert.equal(result.skipped, 10);
    assert.equal(result.attempted, 0);
    assert.equal(result.succeeded, 0);
  });

  it('backfill processes one batch and reports success', async () => {
    let callCount = 0;
    const pool = {
      query: mock.fn((_sql: string, _params?: unknown[]) => {
        callCount++;
        if (callCount === 1) {
          // countMissing — return 2 missing
          return Promise.resolve({ rows: [{ cnt: 2 }], rowCount: 1 });
        }
        if (callCount === 2) {
          // batch query — return 2 rows
          return Promise.resolve({
            rows: [{ id: 1, content: 'hello' }, { id: 2, content: 'world' }],
            rowCount: 2,
          });
        }
        // storeEmbedding update + insert — return empty
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };
    const bf = makeBackfill(pool as any);
    const result = await bf.backfill({ batchSize: 50, batchDelayMs: 0, dryRun: false });

    assert.equal(result.totalMissing, 2);
    assert.equal(result.succeeded, 2);
    assert.equal(result.failed, 0);
    assert.equal(result.isComplete, true);
  });

  it('backfill handles errors gracefully', async () => {
    let callCount = 0;
    const pool = {
      query: mock.fn((_sql: string, _params?: unknown[]) => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ rows: [{ cnt: 1 }], rowCount: 1 });
        if (callCount === 2) return Promise.resolve({ rows: [{ id: 99, content: 'oops' }], rowCount: 1 });
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };
    const gen = { generate: mock.fn(() => Promise.reject(new Error('API down'))) };
    const fakeDb = { getPool: () => pool };
    const bf = new EmbeddingBackfill(fakeDb as any, gen as any);

    const result = await bf.backfill({ batchSize: 50, batchDelayMs: 0, dryRun: false });
    assert.equal(result.attempted, 1);
    assert.equal(result.succeeded, 0);
    assert.equal(result.failed, 1);
    assert.equal(result.isComplete, true);
  });

  it('backfill respects maxTotal limit', async () => {
    const pool = {
      query: mock.fn((_sql: string, _params?: unknown[]) => {
        return Promise.resolve({ rows: [{ cnt: 100 }], rowCount: 1 });
      }),
    };
    const bf = makeBackfill(pool as any);
    const result = await bf.backfill({ maxTotal: 5, dryRun: true });
    // dryRun returns skipped = totalMissing, not maxTotal
    assert.equal(result.skipped, 100);
  });
});

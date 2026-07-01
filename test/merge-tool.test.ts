import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryMerger } from '../dist/merge-tool.js';

function makePool(queries: Record<string, unknown[] | (() => Promise<unknown>)>) {
  return {
    query: mock.fn((sql: string, _params?: unknown[]) => {
      for (const [key, val] of Object.entries(queries)) {
        if (sql.includes(key)) {
          if (typeof val === 'function') return (val as () => Promise<unknown>)();
          return Promise.resolve({ rows: val, rowCount: val.length });
        }
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
  };
}

function makeMerger(pool: ReturnType<typeof makePool>) {
  const fakeDb = { getPool: () => pool };
  return new MemoryMerger(fakeDb as any);
}

describe('MemoryMerger', () => {
  it('returns empty report when no duplicates exist', async () => {
    const pool = makePool({
      'SELECT COUNT(*)::int AS cnt FROM memories WHERE superseded_by IS NULL': [{ cnt: 100 }],
      'GROUP BY LOWER(TRIM(m.content))': [],
    });
    const merger = makeMerger(pool);
    const report = await merger.merge();
    assert.equal(report.totalCanonical, 0);
    assert.equal(report.totalDuplicates, 0);
    assert.equal(report.activeBefore, 100);
    assert.equal(report.activeAfter, 100);
  });

  it('finds exact content duplicates in dry-run mode', async () => {
    let queryCount = 0;
    const pool = {
      query: mock.fn((sql: string, _params?: unknown[]) => {
        queryCount++;
        if (queryCount === 1) {
          // countActive
          return Promise.resolve({ rows: [{ cnt: 50 }], rowCount: 1 });
        }
        if (queryCount === 2) {
          // findDuplicateGroups
          return Promise.resolve({
            rows: [
              {
                hash_key: 'hello world',
                canonical_id: 1,
                all_ids: [1, 5, 10],
                cnt: 3,
                memory_type: 'conversation',
                first_content: 'hello world',
                first_created_at: '2024-01-01',
              },
              {
                hash_key: 'retry',
                canonical_id: 2,
                all_ids: [2, 6],
                cnt: 2,
                memory_type: 'conversation',
                first_content: 'retry',
                first_created_at: '2024-01-02',
              },
            ],
            rowCount: 2,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };
    const merger = makeMerger(pool as any);
    const report = await merger.merge({ dryRun: true });

    assert.equal(report.dryRun, true);
    assert.equal(report.totalCanonical, 2);
    assert.equal(report.totalDuplicates, 3); // 5,10 from group 1 + 6 from group 2
    assert.equal(report.groups.length, 2);
    assert.equal(report.groups[0].canonicalId, 1);
    assert.deepEqual(report.groups[0].duplicateIds, [5, 10]);
    assert.equal(report.groups[0].memoryType, 'conversation');
    assert.equal(report.groups[1].canonicalId, 2);
    assert.deepEqual(report.groups[1].duplicateIds, [6]);
  });

  it('marks duplicates as superseded in apply mode', async () => {
    const pool = {
      query: mock.fn((sql: string, _params?: unknown[]) => {
        if (sql.includes('FROM memories WHERE superseded_by IS NULL')) {
          // countActive
          return Promise.resolve({ rows: [{ cnt: 50 }], rowCount: 1 });
        }
        if (sql.includes('GROUP BY LOWER')) {
          return Promise.resolve({
            rows: [
              {
                hash_key: 'dup content',
                canonical_id: 100,
                all_ids: [100, 101, 102],
                cnt: 3,
                memory_type: 'procedural',
                first_content: 'dup content',
                first_created_at: '2024-01-01',
              },
            ],
            rowCount: 1,
          });
        }
        if (sql.includes('UPDATE memories')) {
          return Promise.resolve({ rows: [], rowCount: 2 });
        }
        if (sql.includes('INSERT INTO memory_merges')) {
          return Promise.resolve({ rows: [{ id: 1 }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };
    const merger = makeMerger(pool as any);
    const report = await merger.merge({ dryRun: false });

    assert.equal(report.dryRun, false);
    assert.equal(report.totalCanonical, 1);
    assert.equal(report.totalDuplicates, 2);
    assert.equal(report.activeBefore, 50);
    // activeAfter will be 50 because countActive mock returns 50 for all matches
  });

  it('excludes lesson type by default', async () => {
    const pool = {
      query: mock.fn((sql: string, params?: unknown[]) => {
        if (sql.includes('FROM memories WHERE superseded_by IS NULL')) {
          return Promise.resolve({ rows: [{ cnt: 10 }], rowCount: 1 });
        }
        if (sql.includes('GROUP BY LOWER')) {
          // Verify lesson exclusion in WHERE clause
          assert.ok(sql.includes('memory_type != ALL'));
          assert.deepEqual(params?.[0], ['lesson']);
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };
    const merger = makeMerger(pool as any);
    await merger.merge();
  });

  it('respects maxGroups limit', async () => {
    const pool = {
      query: mock.fn((sql: string, _params?: unknown[]) => {
        if (sql.includes('FROM memories WHERE superseded_by IS NULL')) {
          return Promise.resolve({ rows: [{ cnt: 100 }], rowCount: 1 });
        }
        if (sql.includes('GROUP BY LOWER')) {
          assert.ok(sql.includes('LIMIT'));
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };
    const merger = makeMerger(pool as any);
    await merger.merge({ maxGroups: 5 });
  });

  it('filters by memoryType when specified', async () => {
    const pool = {
      query: mock.fn((sql: string, params?: unknown[]) => {
        if (sql.includes('FROM memories WHERE superseded_by IS NULL')) {
          return Promise.resolve({ rows: [{ cnt: 10 }], rowCount: 1 });
        }
        if (sql.includes('GROUP BY LOWER')) {
          assert.ok(sql.includes('memory_type = ANY'));
          assert.deepEqual(params?.[1], ['procedural']);
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };
    const merger = makeMerger(pool as any);
    await merger.merge({ memoryTypes: ['procedural'] });
  });

  it('repeated run is idempotent (superseded rows excluded)', async () => {
    let dupCalls = 0;
    const pool = {
      query: mock.fn((sql: string, _params?: unknown[]) => {
        if (sql.includes('FROM memories WHERE superseded_by IS NULL')) {
          return Promise.resolve({ rows: [{ cnt: 10 }], rowCount: 1 });
        }
        if (sql.includes('GROUP BY LOWER')) {
          dupCalls++;
          // First time: return a group. Second time: empty (already superseded)
          return Promise.resolve({
            rows: dupCalls > 1 ? [] : [{
              hash_key: 'dup',
              canonical_id: 1,
              all_ids: [1, 2],
              cnt: 2,
              memory_type: 'conversation',
              first_content: 'dup',
              first_created_at: '2024-01-01',
            }],
            rowCount: dupCalls > 1 ? 0 : 1,
          });
        }
        if (sql.includes('UPDATE memories') || sql.includes('INSERT INTO memory_merges')) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };
    const merger = makeMerger(pool as any);
    await merger.merge({ dryRun: false });
    const report2 = await merger.merge({ dryRun: false });
    assert.equal(report2.totalCanonical, 0);
  });
});

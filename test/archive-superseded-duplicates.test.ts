import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ARCHIVE_REASON, SupersededDuplicateArchiver } from '../src/archive-superseded-duplicates.js';

function makePool(queryImpl: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>) {
  return {
    query: mock.fn(queryImpl),
    connect: async () => ({
      query: mock.fn(queryImpl),
      release: () => undefined,
    }),
  };
}

function makeArchiver(pool: ReturnType<typeof makePool>) {
  return new SupersededDuplicateArchiver({ getPool: () => pool } as any);
}

describe('SupersededDuplicateArchiver', () => {
  it('dry-run writes nothing and reports eligible superseded rows', async () => {
    const pool = makePool(async (sql) => {
      if (sql.includes('COUNT(*) FILTER')) return { rows: [{ total_superseded: 3, already_archived_reason: 1, eligible_count: 2 }], rowCount: 1 };
      if (sql.includes('WHERE superseded_by IS NOT NULL')) return { rows: [{ id: 11 }, { id: 12 }], rowCount: 2 };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const report = await makeArchiver(pool).archive();
    assert.equal(report.dryRun, true);
    assert.equal(report.targetedCount, 2);
    assert.equal(report.updatedCount, 0);
  });

  it('apply marks only superseded rows and skips already archived reason rows', async () => {
    const calls: string[] = [];
    const pool = makePool(async (sql, params) => {
      calls.push(sql);
      if (sql.includes('COUNT(*) FILTER')) return { rows: [{ total_superseded: 4, already_archived_reason: 1, eligible_count: 2 }], rowCount: 1 };
      if (sql.includes('WHERE superseded_by IS NOT NULL')) return { rows: [{ id: 21 }, { id: 22 }], rowCount: 2 };
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 };
      if (sql.includes('SET archived_at = now()')) {
        assert.deepEqual(params?.[0], [21, 22]);
        assert.equal(params?.[1], ARCHIVE_REASON);
        return { rows: [], rowCount: 2 };
      }
      if (sql.includes('COUNT(*)::int AS cnt FROM memories WHERE archive_batch_id = $1')) return { rows: [{ cnt: 2 }], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const report = await makeArchiver(pool).archive({ apply: true, batchId: 'batch-a' });
    assert.equal(report.updatedCount, 2);
    assert.equal(report.batchCountAfter, 2);
    assert.equal(calls.some((sql) => sql.includes('WHERE superseded_by IS NOT NULL')), true);
  });

  it('scope excludes active tiny junk rows by selecting only superseded memories', async () => {
    const pool = makePool(async (sql) => {
      if (sql.includes('COUNT(*) FILTER')) return { rows: [{ total_superseded: 1, already_archived_reason: 0, eligible_count: 1 }], rowCount: 1 };
      if (sql.includes('SELECT id')) {
        assert.equal(sql.includes('superseded_by IS NOT NULL'), true);
        assert.equal(sql.includes('quality_score'), false);
        return { rows: [{ id: 31 }], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const report = await makeArchiver(pool).archive();
    assert.equal(report.targetedCount, 1);
  });

  it('restore clears archive fields by batch', async () => {
    const pool = makePool(async (sql, params) => {
      if (sql.includes('archive_batch_id = $1') && sql.startsWith('SELECT id')) return { rows: [{ id: 41 }, { id: 42 }], rowCount: 2 };
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 };
      if (sql.includes('SET archived_at = NULL')) {
        assert.equal(params?.[0], 'batch-restore');
        return { rows: [], rowCount: 2 };
      }
      if (sql.includes('COUNT(*)::int AS cnt FROM memories WHERE archive_batch_id = $1')) return { rows: [{ cnt: 0 }], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const report = await makeArchiver(pool).restore({ apply: true, batchId: 'batch-restore' });
    assert.equal(report.updatedCount, 2);
    assert.equal(report.batchCountAfter, 0);
  });
});

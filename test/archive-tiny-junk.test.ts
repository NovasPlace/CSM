import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ARCHIVE_REASON, TinyJunkArchiver } from '../src/archive-tiny-junk.js';

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
  return new TinyJunkArchiver({ getPool: () => pool } as any);
}

describe('TinyJunkArchiver', () => {
  it('dry-run writes nothing and reports eligible tiny-junk rows', async () => {
    let updateSeen = false;
    const pool = makePool(async (sql) => {
      if (sql.includes('WITH junk AS')) return { rows: [{ total_active_junk: 2, already_archived_reason: 0 }], rowCount: 1 };
      if (sql.startsWith('SELECT m.id, m.memory_type')) return { rows: [{ id: 11, memory_type: 'episodic', content: '[modified] x.ts' }, { id: 12, memory_type: 'conversation', content: '[user] ok' }], rowCount: 2 };
      if (sql.includes('UPDATE memories')) { updateSeen = true; return { rows: [], rowCount: 0 }; }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const report = await makeArchiver(pool).archive();
    assert.equal(report.dryRun, true);
    assert.equal(report.targetedCount, 2);
    assert.equal(report.updatedCount, 0);
    assert.equal(updateSeen, false, 'dry-run must not issue UPDATE');
  });

  it('apply targets only active non-archived rows matching junk criteria', async () => {
    const calls: string[] = [];
    const pool = makePool(async (sql, params) => {
      calls.push(sql);
      if (sql.includes('WITH junk AS')) return { rows: [{ total_active_junk: 1, already_archived_reason: 0 }], rowCount: 1 };
      if (sql.startsWith('SELECT m.id, m.memory_type')) return { rows: [{ id: 21, memory_type: 'episodic', content: '[modified] a.toml' }], rowCount: 1 };
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 };
      if (sql.includes('SET archived_at = now()')) {
        assert.deepEqual(params?.[0], [21]);
        assert.equal(params?.[1], ARCHIVE_REASON);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('COUNT(*)::int AS cnt FROM memories WHERE archive_batch_id')) return { rows: [{ cnt: 1 }], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const report = await makeArchiver(pool).archive({ apply: true, batchId: 'batch-tj-a' });
    assert.equal(report.updatedCount, 1);
    assert.equal(report.batchCountAfter, 1);
  });

  it('medium-band conversation junk is excluded via maxQualityScore filter', async () => {
    const pool = makePool(async (sql, params) => {
      if (sql.includes('WITH junk AS')) {
        // Verify the quality score param is 0.4 (medium band threshold)
        assert.equal(params?.[4], 0.4);
        return { rows: [{ total_active_junk: 0, already_archived_reason: 0 }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT m.id, m.memory_type')) {
        assert.equal(sql.includes('COALESCE(mq.score, 0.3) <= $5'), true);
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const report = await makeArchiver(pool).archive();
    assert.equal(report.targetedCount, 0);
  });

  it('low_access rows are excluded because access_count filter requires <= lowAccessMax', async () => {
    const pool = makePool(async (sql, params) => {
      if (sql.includes('WITH junk AS')) {
        assert.equal(params?.[3], 1, 'lowAccessMax should default to 1');
        return { rows: [{ total_active_junk: 0, already_archived_reason: 0 }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT m.id, m.memory_type')) {
        assert.equal(sql.includes('COALESCE(m.access_count, 0) <= $4'), true);
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const report = await makeArchiver(pool).archive();
    assert.equal(report.targetedCount, 0);
  });

  it('superseded duplicates are excluded via superseded_by IS NULL guard', async () => {
    const pool = makePool(async (sql) => {
      if (sql.includes('WITH junk AS') || sql.startsWith('SELECT m.id, m.memory_type')) {
        assert.equal(sql.includes('m.superseded_by IS NULL'), true);
        return { rows: sql.includes('WITH junk AS') ? [{ total_active_junk: 0, already_archived_reason: 0 }] : [], rowCount: 0 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const report = await makeArchiver(pool).archive();
    assert.equal(report.targetedCount, 0);
  });

  it('restore clears only archive fields for the given batch', async () => {
    const pool = makePool(async (sql, params) => {
      if (sql.includes('archive_batch_id = $1') && sql.startsWith('SELECT id')) return { rows: [{ id: 41 }, { id: 42 }], rowCount: 2 };
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 };
      if (sql.includes('SET archived_at = NULL')) {
        assert.equal(params?.[0], 'batch-tj-restore');
        return { rows: [], rowCount: 2 };
      }
      if (sql.includes('COUNT(*)::int AS cnt FROM memories WHERE archive_batch_id')) return { rows: [{ cnt: 0 }], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const report = await makeArchiver(pool).restore({ apply: true, batchId: 'batch-tj-restore' });
    assert.equal(report.updatedCount, 2);
    assert.equal(report.batchCountAfter, 0);
  });

  it('apply safety guard requires superseded_by IS NULL and archived_at IS NULL', async () => {
    const pool = makePool(async (sql) => {
      if (sql.includes('WITH junk AS')) return { rows: [{ total_active_junk: 1, already_archived_reason: 0 }], rowCount: 1 };
      if (sql.startsWith('SELECT m.id, m.memory_type')) return { rows: [{ id: 51, memory_type: 'episodic', content: '[modified] b.rs' }], rowCount: 1 };
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 };
      if (sql.includes('SET archived_at = now()')) {
        assert.equal(sql.includes('AND superseded_by IS NULL'), true, 'UPDATE must guard on superseded_by IS NULL');
        assert.equal(sql.includes('AND archived_at IS NULL'), true, 'UPDATE must guard on archived_at IS NULL');
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('COUNT(*)::int AS cnt FROM memories WHERE archive_batch_id')) return { rows: [{ cnt: 1 }], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const report = await makeArchiver(pool).archive({ apply: true, batchId: 'batch-tj-guard' });
    assert.equal(report.updatedCount, 1);
  });
});

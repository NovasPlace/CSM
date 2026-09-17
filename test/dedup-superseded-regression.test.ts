import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DedupCandidateDetector } from '../dist/dedup-detector.js';

describe('DedupCandidateDetector superseded-memory filtering', () => {
  it('excludes superseded memories from both candidate scans and ANN neighbors', async () => {
    const pool = {
      query: mock.fn((sql: string, _params?: unknown[]) => {
        if (sql.includes('FROM memories WHERE embedding IS NOT NULL')) {
          assert.ok(
            sql.includes('superseded_by IS NULL'),
            `candidate query must ignore superseded memories: ${sql}`,
          );
          return Promise.resolve({
            rows: [
              {
                id: 1,
                content: 'active memory',
                memory_type: 'conversation',
                title: '',
                created_at: '2026-09-17',
              },
            ],
            rowCount: 1,
          });
        }

        if (sql.includes('FROM memory_chunks mc')) {
          assert.ok(
            sql.includes('m.superseded_by IS NULL'),
            `neighbor query must ignore superseded memories: ${sql}`,
          );
          return Promise.resolve({ rows: [], rowCount: 0 });
        }

        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };

    const fakeDb = { getPool: () => pool };
    const detector = new DedupCandidateDetector(fakeDb as any);
    const report = await detector.findCandidates();

    assert.equal(report.clusters.length, 0);
    assert.equal(report.totalCandidates, 1);
    assert.ok(pool.query.mock.calls.length >= 2);
  });
});

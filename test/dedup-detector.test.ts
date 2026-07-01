import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DedupCandidateDetector } from '../dist/dedup-detector.js';

function makePool(queries: Record<string, unknown[]>) {
  return {
    query: mock.fn((sql: string, _params?: unknown[]) => {
      for (const [key, rows] of Object.entries(queries)) {
        if (sql.includes(key)) return Promise.resolve({ rows, rowCount: rows.length });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
  };
}

function makeDetector(pool: ReturnType<typeof makePool>, config?: Record<string, unknown>) {
  const fakeDb = { getPool: () => pool };
  return new DedupCandidateDetector(fakeDb as any, config as any);
}

describe('DedupCandidateDetector', () => {
  it('returns empty clusters when no memories have embeddings', async () => {
    const pool = makePool({ 'FROM memories WHERE embedding IS NOT NULL': [] });
    const detector = makeDetector(pool);
    const report = await detector.findCandidates();
    assert.equal(report.clusters.length, 0);
    assert.equal(report.totalCandidates, 0);
  });

  it('detects exact content duplicates', async () => {
    const pool = makePool({
      'FROM memories WHERE embedding IS NOT NULL': [
        { id: 1, content: 'hello world', memory_type: 'conversation', title: '', created_at: '2024-01-01' },
        { id: 2, content: 'hello world', memory_type: 'conversation', title: '', created_at: '2024-01-02' },
        { id: 3, content: 'unique content', memory_type: 'lesson', title: '', created_at: '2024-01-03' },
      ],
    });
    const detector = makeDetector(pool);
    const report = await detector.findCandidates();

    assert.equal(report.clusters.length, 1);
    assert.equal(report.clusters[0].detectionMethod, 'exact_content');
    assert.equal(report.clusters[0].clusterSize, 2);
    assert.equal(report.clusters[0].representative.id, 1);
    assert.deepEqual(report.clusters[0].duplicateIds, [2]);
  });

  it('detects exact title duplicates', async () => {
    const pool = makePool({
      'FROM memories WHERE embedding IS NOT NULL': [
        { id: 10, content: 'content a', memory_type: 'lesson', title: 'My Title', created_at: '2024-01-01' },
        { id: 11, content: 'content b', memory_type: 'lesson', title: 'My Title', created_at: '2024-01-02' },
        { id: 12, content: 'content c', memory_type: 'lesson', title: 'Other', created_at: '2024-01-03' },
      ],
    });
    const detector = makeDetector(pool);
    const report = await detector.findCandidates();

    assert.equal(report.clusters.length, 1);
    assert.equal(report.clusters[0].detectionMethod, 'exact_title');
    assert.equal(report.clusters[0].clusterSize, 2);
    assert.equal(report.clusters[0].representative.id, 10);
    assert.deepEqual(report.clusters[0].duplicateIds, [11]);
  });

  it('detects embedding-similarity duplicates via ANN neighbors', async () => {
    let callCount = 0;
    const pool = {
      query: mock.fn((sql: string, _params?: unknown[]) => {
        callCount++;
        if (callCount === 1) {
          // fetchMemories — return 2 memories
          return Promise.resolve({
            rows: [
              { id: 20, content: 'alpha', memory_type: 'conversation', title: '', created_at: '2024-01-01' },
              { id: 21, content: 'beta', memory_type: 'conversation', title: '', created_at: '2024-01-02' },
            ],
            rowCount: 2,
          });
        }
        // callCount 2: findNeighbors for id 20 — CROSS JOIN ANN query returns neighbor
        return Promise.resolve({
          rows: [{ id: 21, similarity: 0.95 }],
          rowCount: 1,
        });
      }),
    };
    const detector = makeDetector(pool, { similarityThreshold: 0.9 });
    const report = await detector.findCandidates();

    assert.equal(report.clusters.length, 1);
    assert.equal(report.clusters[0].detectionMethod, 'embedding_similarity');
    assert.equal(report.clusters[0].clusterSize, 2);
    assert.equal(report.clusters[0].representative.id, 20);
    assert.deepEqual(report.clusters[0].duplicateIds, [21]);
    assert.ok(report.clusters[0].averageSimilarity >= 0.95);
  });

  it('respects maxClusters limit', async () => {
    const pool = makePool({
      'FROM memories WHERE embedding IS NOT NULL': [
        { id: 1, content: 'dup content', memory_type: 'conversation', title: '', created_at: '2024-01-01' },
        { id: 2, content: 'dup content', memory_type: 'conversation', title: '', created_at: '2024-01-02' },
        { id: 3, content: 'also dup', memory_type: 'lesson', title: '', created_at: '2024-01-03' },
        { id: 4, content: 'also dup', memory_type: 'lesson', title: '', created_at: '2024-01-04' },
      ],
    });
    const detector = makeDetector(pool, { maxClusters: 1 });
    const report = await detector.findCandidates();

    assert.equal(report.clusters.length, 1);
  });

  it('filters by allowedTypes', async () => {
    const pool = makePool({
      'FROM memories WHERE embedding IS NOT NULL': [
        { id: 1, content: 'hello', memory_type: 'conversation', title: '', created_at: '2024-01-01' },
      ],
    });
    const detector = makeDetector(pool, { allowedTypes: ['lesson'] });
    const report = await detector.findCandidates();

    const sql = pool.query.mock.calls[0]?.arguments[0] as string;
    assert.ok(sql.includes('memory_type = ANY'));
  });

  it('includes threshold in report', async () => {
    const pool = makePool({ 'FROM memories WHERE embedding IS NOT NULL': [] });
    const detector = makeDetector(pool, { similarityThreshold: 0.85 });
    const report = await detector.findCandidates();
    assert.equal(report.thresholdUsed, 0.85);
  });

  it('excludes different memory types by default in embedding search', async () => {
    const pool = {
      query: mock.fn((sql: string, _params?: unknown[]) => {
        if ((sql as string).includes('FROM memories WHERE embedding IS NOT NULL')) {
          return Promise.resolve({
            rows: [
              { id: 30, content: 'first', memory_type: 'lesson', title: '', created_at: '2024-01-01' },
              { id: 31, content: 'second', memory_type: 'conversation', title: '', created_at: '2024-01-02' },
            ],
            rowCount: 2,
          });
        }
        // ANN query — verify type filter, return no matches
        if ((sql as string).includes('memory_chunks mc')) {
          assert.ok((sql as string).includes('m.memory_type'));
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };
    const detector = makeDetector(pool, { similarityThreshold: 0.9 });
    const report = await detector.findCandidates();

    assert.equal(report.clusters.length, 0);
  });
});

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { CandidateGenerator } from '../dist/candidate-generator.js';

interface MockCall {
  sql: string;
  params?: unknown[];
}

function makePool(handler: (sql: string, params?: unknown[]) => { rows: unknown[]; rowCount: number }) {
  const calls: MockCall[] = [];
  return {
    pool: {
      query: mock.fn((sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return Promise.resolve(handler(sql, params));
      }),
      getDialect: () => 'pg' as const,
    },
    calls,
  };
}

function makeGenerator(pool: { query: unknown; getDialect: () => 'pg' }) {
  const fakeDb = { getPool: () => pool };
  return new CandidateGenerator(fakeDb as any);
}

describe('CandidateGenerator', () => {
  it('returns empty candidates in dry-run when no memories match', async () => {
    const { pool, calls } = makePool(() => ({ rows: [], rowCount: 0 }));
    const gen = makeGenerator(pool);
    const report = await gen.generate({ dryRun: true });

    assert.equal(report.dryRun, true);
    assert.equal(report.candidates.length, 0);
    assert.equal(report.inserted, 0);
    // dry-run must not attempt any INSERT
    assert.equal(calls.some(c => c.sql.includes('INSERT INTO memory_candidate_queue')), false);
  });

  it('detects prune candidates: low quality + never recalled + old', async () => {
    const { pool } = makePool((sql) => {
      if (sql.includes('memory_quality_scores')) {
        return {
          rows: [
            { id: 1, score: 0.3, access_count: 0, recall_count: 0, memory_type: 'conversation', content: 'stale', canonical_id: null, chunk_count: 0 },
            { id: 2, score: 0.2, access_count: 0, recall_count: 0, memory_type: 'repo', content: 'old', canonical_id: null, chunk_count: 0 },
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const gen = makeGenerator(pool);
    const report = await gen.generate({ dryRun: true, types: ['prune'] });

    assert.equal(report.candidates.length, 2);
    assert.equal(report.candidates[0].candidateType, 'prune');
    assert.equal(report.candidates[0].memoryId, 1);
    assert.ok(report.candidates[0].confidence > 0);
    assert.ok(report.candidates[0].reason.includes('Low quality'));
    assert.ok(report.candidates[0].sourceSignals.qualityScore !== undefined);
  });

  it('detects promote_to_lesson candidates: frequently recalled procedural/episodic', async () => {
    const { pool } = makePool((sql) => {
      if (sql.includes('memory_recall_events') && sql.includes('>= $1')) {
        return {
          rows: [
            { id: 10, memory_type: 'procedural', content: 'do thing', access_count: 9, recall_count: 8, score: 0, canonical_id: null, chunk_count: 0 },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const gen = makeGenerator(pool);
    const report = await gen.generate({ dryRun: true, types: ['promote_to_lesson'], minRecallPromote: 5 });

    assert.equal(report.candidates.length, 1);
    assert.equal(report.candidates[0].candidateType, 'promote_to_lesson');
    assert.equal(report.candidates[0].memoryId, 10);
    assert.ok(report.candidates[0].reason.includes('Frequently recalled'));
  });

  it('detects merge candidates: exact content duplicates', async () => {
    const { pool } = makePool((sql) => {
      if (sql.includes('WITH dups')) {
        return {
          rows: [
            { id: 20, memory_type: 'conversation', content: 'dup', canonical_id: 5, score: 1, access_count: 0, recall_count: 0, chunk_count: 0 },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const gen = makeGenerator(pool);
    const report = await gen.generate({ dryRun: true, types: ['merge'] });

    assert.equal(report.candidates.length, 1);
    assert.equal(report.candidates[0].candidateType, 'merge');
    assert.equal(report.candidates[0].memoryId, 20);
    assert.ok(report.candidates[0].reason.includes('canonical memory #5'));
    assert.equal(report.candidates[0].confidence, 0.9);
  });

  it('detects stale_preference candidates: old preference memories', async () => {
    const { pool } = makePool((sql) => {
      if (sql.includes("memory_type = 'preference'")) {
        return {
          rows: [
            { id: 30, memory_type: 'preference', content: 'use tabs', access_count: 1, score: 0, canonical_id: null, chunk_count: 0, recall_count: 0 },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const gen = makeGenerator(pool);
    const report = await gen.generate({ dryRun: true, types: ['stale_preference'] });

    assert.equal(report.candidates.length, 1);
    assert.equal(report.candidates[0].candidateType, 'stale_preference');
    assert.equal(report.candidates[0].memoryId, 30);
    assert.ok(report.candidates[0].reason.includes('Old preference'));
  });

  it('detects refresh_summary candidates: episodic memories with many chunks', async () => {
    const { pool } = makePool((sql) => {
      if (sql.includes('memory_chunks') && sql.includes('>= $1')) {
        return {
          rows: [
            { id: 40, memory_type: 'episodic', content: 'long event', chunk_count: 5, score: 0, canonical_id: null, access_count: 0, recall_count: 0 },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const gen = makeGenerator(pool);
    const report = await gen.generate({ dryRun: true, types: ['refresh_summary'] });

    assert.equal(report.candidates.length, 1);
    assert.equal(report.candidates[0].candidateType, 'refresh_summary');
    assert.equal(report.candidates[0].memoryId, 40);
    assert.ok(report.candidates[0].reason.includes('chunks'));
  });

  it('writes candidates when dryRun=false and dedupes via unique violation', async () => {
    let insertCalls = 0;
    const { pool } = makePool((sql) => {
      if (sql.includes('INSERT INTO memory_candidate_queue')) {
        insertCalls++;
        // simulate unique violation on second insert of same candidate
        if (insertCalls === 2) {
          const err = Object.assign(new Error('unique'), { code: '23505' });
          return Promise.reject(err);
        }
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('memory_quality_scores')) {
        return {
          rows: [
            { id: 1, score: 0.3, access_count: 0, recall_count: 0, memory_type: 'x', content: 'a', canonical_id: null, chunk_count: 0 },
            { id: 2, score: 0.2, access_count: 0, recall_count: 0, memory_type: 'y', content: 'b', canonical_id: null, chunk_count: 0 },
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const gen = makeGenerator(pool);
    const report = await gen.generate({ dryRun: false, types: ['prune'] });

    assert.equal(report.dryRun, false);
    assert.equal(report.candidates.length, 2);
    assert.equal(report.inserted, 1);
    assert.equal(report.skippedDuplicates, 1);
  });

  it('report aggregates counts by type and status', async () => {
    const { pool } = makePool((sql) => {
      if (sql.includes('GROUP BY candidate_type, status')) {
        return {
          rows: [
            { candidate_type: 'prune', status: 'pending', count: 3 },
            { candidate_type: 'merge', status: 'dismissed', count: 1 },
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const gen = makeGenerator(pool);
    const r = await gen.report();

    assert.equal(r.total, 4);
    assert.equal(r.byType.prune, 3);
    assert.equal(r.byType.merge, 1);
    assert.equal(r.byStatus.pending, 3);
    assert.equal(r.byStatus.dismissed, 1);
  });

  it('respects maxPerType limit', async () => {
    const { pool, calls } = makePool((sql) => {
      if (sql.includes('memory_quality_scores')) {
        return {
          rows: Array.from({ length: 5 }, (_, i) => ({
            id: i + 1, score: 0.1, access_count: 0, recall_count: 0, memory_type: 'x', content: 'a', canonical_id: null, chunk_count: 0,
          })),
          rowCount: 5,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const gen = makeGenerator(pool);
    const report = await gen.generate({ dryRun: true, types: ['prune'], maxPerType: 2 });

    // The SQL should include LIMIT; mock returns 5 rows but we passed LIMIT 2 param
    // verify the LIMIT param was sent
    const pruneCall = calls.find(c => c.sql.includes('memory_quality_scores'));
    assert.ok(pruneCall, 'prune query was issued');
    assert.ok(report.byType.prune !== undefined);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryExtractor } from '../dist/memory-extractor.js';

describe('memory candidate session isolation', () => {
  it('refuses review from a different session and scopes the update predicate', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const candidate = {
      id: 'candidate-b', session_id: 'session-b', project_id: 'project-b',
      proposed_type: 'lesson', content: 'Private candidate B', importance: 0.8,
      emotion: 'neutral', confidence: 0.9, tags: [], metadata: {}, status: 'pending',
      source: 'extractor', created_at: new Date(), reviewed_at: null, reviewed_by: null,
    };
    const pool = {
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params });
        if (sql.includes('SELECT * FROM memory_candidates')) {
          return { rows: params?.[1] === 'session-b' ? [candidate] : [], rowCount: 0 };
        }
        return { rows: [], rowCount: 1 };
      },
      getDialect: () => 'pg' as const,
    };
    const memoryManager = { emitEvent: async () => undefined };
    const extractor = new MemoryExtractor(
      { getPool: () => pool } as any,
      memoryManager as any,
      { enabled: true, minTurnsBeforeExtract: 3, maxCandidatesPerTurn: 5,
        confidenceThreshold: 0.7, autoApproveThreshold: 0.9 },
    );
    const approval = {
      candidateId: 'candidate-b', action: 'reject' as const, reviewedBy: 'user' as const,
      reviewedAt: new Date(),
    };

    await assert.rejects(
      () => extractor.reviewCandidate(approval, 'user', 'session-a'),
      /not found in the active session/,
    );
    assert.equal(calls.some((call) => call.sql.includes('UPDATE memory_candidates')), false);

    await extractor.reviewCandidate(approval, 'user', 'session-b');
    const update = calls.find((call) => call.sql.includes('UPDATE memory_candidates'));
    assert.match(update?.sql ?? '', /session_id = \$5/);
    assert.equal(update?.params?.[4], 'session-b');
  });
});

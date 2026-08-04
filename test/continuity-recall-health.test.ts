import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectRecallHealth } from '../src/continuity-resilience-report.js';
import type { DatabasePool } from '../src/types.js';

describe('continuity recall metric semantics', () => {
  it('scores relevance only on ranked search surfaces', async () => {
    const queries: string[] = [];
    const pool = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('GROUP BY source')) {
          return { rows: [{ source: 'context_recall', cnt: 100 }, { source: 'search', cnt: 10 }], rowCount: 2 };
        }
        if (sql.includes('top3_rate')) {
          return { rows: [{ top3_rate: 60, mrr: 0.5, empty_rate: 0, null_rate: 0 }], rowCount: 1 };
        }
        if (sql.includes('fb_rate')) {
          return { rows: [{ fb_rate: 0, graph_count: 0 }], rowCount: 1 };
        }
        if (sql.includes('vec_rate')) {
          return { rows: [{ vec_rate: 99 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    } as unknown as DatabasePool;

    await collectRecallHealth(pool, 'pg', 24);

    const relevanceQuery = queries.find((sql) => sql.includes('top3_rate')) ?? '';
    assert.match(
      relevanceQuery,
      /source IN \('search', 'vector_only', 'text_only', 'text_fallback'\)/,
    );
  });
});

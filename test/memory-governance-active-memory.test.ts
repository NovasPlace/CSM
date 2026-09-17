import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryGovernance } from '../src/memory_governance.js';

describe('MemoryGovernance active-memory enforcement', () => {
  it('filters superseded and archived veto memories at the database boundary', async () => {
    const queries: string[] = [];
    const pool = {
      query: mock.fn(async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      }),
    };

    const governance = new MemoryGovernance(pool as never);
    const result = await governance.evaluate();

    assert.equal(result.accessed, true);
    assert.equal(result.vetoes.length, 0);
    assert.match(queries[0] ?? '', /superseded_by IS NULL/);
    assert.match(queries[0] ?? '', /archived_at IS NULL/);
  });
});

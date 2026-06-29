import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeBridgeTurnJournal } from '../src/bridge-work-journal.js';

describe('bridge work journal capture', () => {
  it('mirrors assistant bridge turns into context_cache decisions', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    await writeBridgeTurnJournal(pool(queries) as any, {
      sessionId: 'session-1',
      projectId: 'workflow-project',
      role: 'assistant',
      content: 'We should continue from the latest failing tool run.',
      resultSummary: 'Synced bridge turn into memory #42.',
    });

    assert.equal(queries.length, 2);
    assert.match(queries[0]!.sql, /INSERT INTO agent_work_journal/);
    assert.match(queries[1]!.sql, /INSERT INTO context_cache/);
    assert.equal(queries[1]!.params[2], 'decision');
    assert.match(String(queries[1]!.params[5]), /\[assistant\]/);
  });
});

function pool(queries: Array<{ sql: string; params: unknown[] }>) {
  return {
    async query(sql: string, params: unknown[]) {
      queries.push({ sql, params });
      return { rows: [] };
    },
  };
}

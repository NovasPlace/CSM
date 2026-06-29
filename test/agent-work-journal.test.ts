import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentWorkJournal } from '../src/agent-work-journal.js';
import type { WorkJournalConfig } from '../src/work-journal-types.js';

const CONFIG: WorkJournalConfig = {
  enabled: true,
  maxResumeEntries: 20,
  maxIntentChars: 200,
  injectMaxTokens: 800,
  autoMarkMilestone: true,
  persistOnDispose: true,
};

describe('AgentWorkJournal flush', () => {
  it('writes files_touched as a Postgres text array, not JSON text', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      async query(sql: string, params: unknown[]) {
        calls.push({ sql, params });
        return { rows: [], rowCount: 1 };
      },
    };

    const journal = new AgentWorkJournal(pool as any, CONFIG);
    journal.recordDecision({
      sessionId: 'session-1',
      projectId: 'cross-session-memory',
      intent: 'Continue implementing the task journal resume path.',
      filesTouched: ['src/work-journal-inject.ts', 'test/agent-work-journal.test.ts'],
      tokenSnapshot: 321,
    });

    await journal.flush();

    assert.equal(calls.length, 1);
    assert.match(calls[0]!.sql, /INSERT INTO agent_work_journal/);
    assert.deepEqual(calls[0]!.params[8], [
      'src/work-journal-inject.ts',
      'test/agent-work-journal.test.ts',
    ]);
    assert.equal(Array.isArray(calls[0]!.params[8]), true);
    assert.equal(typeof calls[0]!.params[8], 'object');
  });
});

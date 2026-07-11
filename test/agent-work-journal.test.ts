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

  it('rejects a failed flush and retries only the uncommitted suffix in order', async () => {
    const inserted: string[] = [];
    let failSecond = true;
    const pool = {
      async query(_sql: string, params: unknown[]) {
        const intent = String(params[4]);
        if (intent === 'second' && failSecond) {
          failSecond = false;
          throw new Error('transient journal failure');
        }
        inserted.push(intent);
        return { rows: [], rowCount: 1 };
      },
    };
    const journal = new AgentWorkJournal(pool as any, CONFIG);
    journal.recordDecision({ sessionId: 'session-1', intent: 'first' });
    journal.recordDecision({ sessionId: 'session-1', intent: 'second' });

    await assert.rejects(() => journal.flush(), /transient journal failure/);
    assert.deepEqual(inserted, ['first']);
    await journal.flush();
    assert.deepEqual(inserted, ['first', 'second']);
  });

  it('does not report session-end persistence success after a write failure', async () => {
    const pool = {
      async query() { throw new Error('journal unavailable'); },
    };
    const journal = new AgentWorkJournal(pool as any, CONFIG);
    await assert.rejects(
      () => journal.recordSessionEnd('session-1', 'project-1', 12),
      /journal unavailable/,
    );
  });

  it('does not duplicate a requeued session-end marker on retry', async () => {
    let fail = true;
    const inserted: string[] = [];
    const pool = {
      async query(_sql: string, params: unknown[]) {
        if (fail) { fail = false; throw new Error('transient end failure'); }
        inserted.push(String(params[2]));
        return { rows: [], rowCount: 1 };
      },
    };
    const journal = new AgentWorkJournal(pool as any, CONFIG);
    await assert.rejects(() => journal.recordSessionEnd('session-1', 'project-1', 12));
    await journal.recordSessionEnd('session-1', 'project-1', 12);
    assert.deepEqual(inserted, ['session_end']);
  });

  it('does not duplicate session-end when a later buffered row fails', async () => {
    const inserted: string[] = [];
    let release!: () => void;
    let entered!: () => void;
    let failDecision = true;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pool = {
      async query(_sql: string, params: unknown[]) {
        const type = String(params[2]);
        if (type === 'session_end') { entered(); await gate; }
        if (type === 'decision' && failDecision) {
          failDecision = false;
          throw new Error('later row failed');
        }
        inserted.push(type);
        return { rows: [], rowCount: 1 };
      },
    };
    const journal = new AgentWorkJournal(pool as any, CONFIG);
    const ending = journal.recordSessionEnd('session-1', 'project-1', 12);
    await started;
    journal.recordDecision({ sessionId: 'session-1', intent: 'later' });
    release();
    await assert.rejects(() => ending, /later row failed/);
    await journal.recordSessionEnd('session-1', 'project-1', 12);
    assert.deepEqual(inserted, ['session_end', 'decision']);
  });

  it('buffers circular and bigint tool arguments without throwing', async () => {
    const intents: string[] = [];
    const circular: Record<string, unknown> = { count: 12n };
    circular.self = circular;
    const pool = {
      async query(_sql: string, params: unknown[]) {
        intents.push(String(params[4]));
        return { rows: [], rowCount: 1 };
      },
    };
    const journal = new AgentWorkJournal(pool as any, CONFIG);
    journal.recordToolCall({ sessionId: 'session-1', toolName: 'unknown',
      args: circular, output: 'ok' });
    await journal.flush();
    assert.match(intents[0]!, /"count":"12"/);
    assert.match(intents[0]!, /\[Circular\]/);
  });

  it('drains entries appended during an active flush before resolving', async () => {
    const inserted: string[] = [];
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pool = {
      async query(_sql: string, params: unknown[]) {
        const intent = String(params[4]);
        if (intent === 'first') { entered(); await gate; }
        inserted.push(intent);
        return { rows: [], rowCount: 1 };
      },
    };
    const journal = new AgentWorkJournal(pool as any, CONFIG);
    journal.recordDecision({ sessionId: 'session-1', intent: 'first' });
    const flushing = journal.flush();
    await started;
    journal.recordDecision({ sessionId: 'session-1', intent: 'second' });
    const coalesced = journal.flush();
    release();
    await Promise.all([flushing, coalesced]);
    assert.deepEqual(inserted, ['first', 'second']);
  });
});

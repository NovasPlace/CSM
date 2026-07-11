import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { AgentWorkJournalReader } from '../src/agent-work-journal-reader.js';
import { getLogger } from '../src/logger.js';
import type { DatabasePool } from '../src/types.js';
import type { WorkJournalConfig } from '../src/work-journal-types.js';

const CONFIG = { maxResumeEntries: 20 } as WorkJournalConfig;

it('does not fall back across projects when scoped history is empty', async () => {
  const sql: string[] = [];
  const reader = new AgentWorkJournalReader(pool(async (query) => {
    sql.push(query);
    return [];
  }), CONFIG);
  const result = await reader.buildResumePayload('current', 'project-empty');
  assert.equal(result, null);
  assert.equal(sql.length, 1);
  assert.match(sql[0]!, /project_id = \$1/);
});

it('selects prior sessions by activity timestamp rather than identifier order', async () => {
  const sql: string[] = [];
  const reader = new AgentWorkJournalReader(pool(async (query) => {
    sql.push(query);
    if (sql.length === 1) return [{ session_id: 'session-recent' }];
    if (sql.length === 2) return [{ id: 2, entry_type: 'decision', tool_name: null,
      intent: 'recent work', target: null, result_summary: null, error_summary: null,
      files_touched: '[]', created_at: '2026-07-11T12:00:00.000Z' }];
    return [{ cnt: '1' }];
  }), CONFIG);
  const result = await reader.buildResumePayload('current', 'project-1');
  assert.equal(result?.fromSessionId, 'session-recent');
  assert.match(sql[0]!, /ORDER BY MAX\(created_at\) DESC, MAX\(id\) DESC/);
  assert.equal(result?.lastActiveAt instanceof Date, true);
});

it('normalizes SQLite UTC text without applying the host timezone', async () => {
  const reader = new AgentWorkJournalReader(pool(async (_query, call) => {
    if (call === 1) return [{ session_id: 'session-1' }];
    if (call === 2) return [{ id: 1, entry_type: 'decision', tool_name: null,
      intent: 'utc work', target: null, result_summary: null, error_summary: null,
      files_touched: '[]', created_at: '2026-07-11 12:34:56' }];
    return [{ cnt: '1' }];
  }), CONFIG);
  const result = await reader.buildResumePayload('current', 'project-1');
  assert.equal(result?.lastActiveAt.toISOString(), '2026-07-11T12:34:56.000Z');
  assert.equal(result?.entries[0]?.createdAt.toISOString(), '2026-07-11T12:34:56.000Z');
});

it('logs malformed timestamp data and degrades to no resume payload', async () => {
  const logged = mock.method(getLogger(), 'error', () => undefined);
  const reader = new AgentWorkJournalReader(pool(async (_query, call) => call === 1
    ? [{ session_id: 'session-1' }]
    : [{ id: 1, entry_type: 'decision', tool_name: null, intent: 'bad date',
      target: null, result_summary: null, error_summary: null, files_touched: [],
      created_at: 'not-a-date' }]), CONFIG);
  assert.equal(await reader.buildResumePayload('current', 'project-1'), null);
  assert.equal(logged.mock.callCount(), 1);
  logged.mock.restore();
});

function pool(
  rows: (sql: string, call: number) => Promise<unknown[]> | unknown[],
): DatabasePool {
  let calls = 0;
  return {
    query: async (sql) => ({ rows: await rows(sql, ++calls), rowCount: null }),
    connect: async () => { throw new Error('not used'); },
    end: async () => undefined,
    getDialect: () => 'pg',
  };
}

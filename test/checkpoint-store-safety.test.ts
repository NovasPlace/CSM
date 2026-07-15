import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { CheckpointStore } from '../dist/checkpoint-store.js';
import { initializeCheckpointSchema } from '../dist/checkpoint-schema.js';

function checkpointRow() {
  return {
    checkpoint_id: '00000000-0000-0000-0000-000000000001',
    session_id: 'session-1', project_id: null, created_at: new Date('2026-01-01T00:00:00Z'),
    source_message_start: 'msg-1', source_message_end: 'msg-2',
    summary_markdown: 'summary', summary_tokens: 1, input_tokens_estimate: 2,
    source_refs: [], compacted_refs: [], files_mentioned: [], tests_mentioned: [],
    risks: [], next_steps: [], supersedes_checkpoint_id: null, schema_version: 1, is_active: true,
  };
}

describe('checkpoint store safety', () => {
  it('serializes checkpoint replacement per session before deactivating the prior active row', async () => {
    const calls: string[] = [];
    const client = {
      query: async (sql: string) => {
        calls.push(sql);
        if (sql.includes('UPDATE checkpoints SET is_active')) return { rows: [] };
        if (sql.includes('INSERT INTO checkpoints')) return { rows: [checkpointRow()] };
        return { rows: [] };
      },
      release: () => {},
    };
    const pool = { connect: async () => client } as any;
    const store = new CheckpointStore(pool);

    await store.createCheckpoint({
      sessionId: 'session-1', summaryMarkdown: 'summary', summaryTokens: 1,
      inputTokensEstimate: 2, sourceRefs: [], compactedRefs: [], filesMentioned: [],
      testsMentioned: [], risks: [], nextSteps: [], rawCaptures: [],
    });

    strictEqual(calls[0], 'BEGIN');
    ok(calls[1].includes('pg_advisory_xact_lock'));
    ok(calls[2].includes('UPDATE checkpoints SET is_active'));
    strictEqual(calls.at(-1), 'COMMIT');
  });

  it('accepts a part ID as an expansion identifier', async () => {
    const queries: string[] = [];
    const pool = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('FROM checkpoints')) return { rows: [checkpointRow()] };
        if (sql.includes('FROM checkpoint_raw_captures')) return { rows: [{
          raw_id: 'raw-1', checkpoint_id: checkpointRow().checkpoint_id,
          message_id: 'msg-1', part_id: 'part-1', tool_call_id: 'call-1',
          kind: 'tool_output', content: 'full output', token_count: 3,
          captured_at: new Date('2026-01-01T00:00:01Z'),
        }] };
        return { rows: [] };
      },
    } as any;
    const store = new CheckpointStore(pool);

    const result = await store.expandRef('session-1', 'part-1');

    strictEqual(result.found, true);
    strictEqual(result.rawCapture?.content, 'full output');
    ok(queries.some((sql) => sql.includes('part_id = $2')));
  });

  it('repairs duplicate active rows before installing the unique active-checkpoint index', async () => {
    const queries: string[] = [];
    const pool = { query: async (sql: string) => { queries.push(sql); return { rows: [] }; } } as any;

    await initializeCheckpointSchema(pool);

    const repairIndex = queries.findIndex((sql) => sql.includes('ROW_NUMBER() OVER'));
    const uniqueIndex = queries.findIndex((sql) => sql.includes('uq_checkpoints_one_active'));
    ok(repairIndex >= 0);
    ok(uniqueIndex > repairIndex);
  });
});

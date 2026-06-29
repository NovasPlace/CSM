import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createToolExecuteAfterHook } from '../src/hooks/tool-execute.js';
import type { PluginContext } from '../src/plugin-context.js';

describe('tool execute work journal hook', () => {
  it('records the current token snapshot with the tool call entry', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const snapshots: number[] = [];
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const hook = createToolExecuteAfterHook(context(calls, snapshots, queries));

    await hook(
      { sessionID: 'session-1', tool: 'bash', args: { command: 'npm test' } },
      { output: 'ok', metadata: { tokenCount: 432, exitCode: 0 } },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.tokenSnapshot, 432);
    assert.deepEqual(snapshots, [432]);
    assert.equal(queries.length, 0);
  });

  it('caches failed tool executions as error recovery signals', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const hook = createToolExecuteAfterHook(context([], [], queries));

    await hook(
      { sessionID: 'session-1', tool: 'bash', args: { command: 'npm test' } },
      { output: 'FAIL src/bridge.test.ts', metadata: { tokenCount: 200, exitCode: 1, error: 'Tests failed' } },
    );

    assert.equal(queries.length, 1);
    assert.match(queries[0]!.sql, /INSERT INTO context_cache/);
    assert.equal(queries[0]!.params[2], 'error');
    assert.match(String(queries[0]!.params[5]), /error in bash/);
  });
});

function context(
  calls: Array<Record<string, unknown>>,
  snapshots: number[],
  queries: Array<{ sql: string; params: unknown[] }>,
): PluginContext {
  return {
    directory: 'workflow-project',
    config: {
      workJournal: { enabled: true },
      distiller: { enabled: false },
      logToolUsage: false,
    },
    state: {
      currentSessionId: 'session-1',
      messageCount: 0,
      capturedMessageSizes: new Map(),
      recentUserMessages: new Map(),
      _docsInitialized: true,
    },
    syncActiveSession() {},
    database: {
      getPool() {
        return {
          async query(sql: string, params: unknown[]) {
            queries.push({ sql, params });
            return { rows: [] };
          },
        };
      },
    },
    workJournal: {
      recordToolCall(entry: Record<string, unknown>) {
        calls.push(entry);
      },
      updateTokenSnapshot(value: number) {
        snapshots.push(value);
      },
    },
    toolDistiller: {
      bufferLength: 0,
      record() {},
    },
  } as PluginContext;
}

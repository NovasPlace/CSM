import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { ContextCompactor } from '../dist/context-compactor.js';
import { createMessagesTransformHook } from '../dist/hooks/messages-transform.js';
import type { PluginContext } from '../src/plugin-context.js';

const SESSION_ID = 'compaction-safety';

function runtimeContext(): PluginContext {
  return {
    state: {
      currentSessionId: SESSION_ID,
      recentUserMessages: new Map<string, string>(),
    },
    contextCompactor: new ContextCompactor({
      enabled: true,
      workingMemoryWindow: 0,
      minAgeMs: 0,
      maxOutputChars: 120,
      truncateInput: true,
      budgetCapEnabled: false,
      budgetCapPercent: 25,
      budgetCapPressureThreshold: 0.6,
      budgetCapMaxIterations: 3,
    }),
    database: {
      getPool: () => ({
        query: async () => ({ rows: [], rowCount: 0 }),
      }),
    },
  } as unknown as PluginContext;
}

function toolPart(tool: string, output: string, timestamp: number) {
  return {
    type: 'tool',
    tool,
    sessionID: SESSION_ID,
    state: {
      status: 'completed',
      input: tool === 'bash' ? { command: 'git status' } : { filePath: 'src/example.ts' },
      output,
      time: { start: timestamp, end: timestamp + 1 },
    },
  };
}

describe('messages transform compaction safety', () => {
  it('never replaces tool outputs produced after the latest user message', async () => {
    const oldTimestamp = Date.now() - 120_000;
    const currentTimestamp = Date.now() - 90_000;
    const messages = [
      { info: { role: 'user', sessionID: SESSION_ID }, parts: [{ type: 'text', text: 'previous task' }] },
      { info: { role: 'assistant', sessionID: SESSION_ID }, parts: [toolPart('read', 'old file contents', oldTimestamp)] },
      { info: { role: 'user', sessionID: SESSION_ID }, parts: [{ type: 'text', text: 'current task' }] },
      { info: { role: 'assistant', sessionID: SESSION_ID }, parts: [toolPart('read', 'current file contents', currentTimestamp)] },
      { info: { role: 'assistant', sessionID: SESSION_ID }, parts: [toolPart('bash', 'working tree is clean', currentTimestamp + 10)] },
    ];

    await createMessagesTransformHook(runtimeContext())({}, { messages });

    const oldOutput = messages[1].parts[0].state.output;
    const currentReadOutput = messages[3].parts[0].state.output;
    const currentGitOutput = messages[4].parts[0].state.output;
    ok(oldOutput.startsWith('TOOL_REF'));
    strictEqual(currentReadOutput, 'current file contents');
    strictEqual(currentGitOutput, 'working tree is clean');
  });

  it('filters existing TOOL_REF results before compaction and remains idempotent', async () => {
    const firstTimestamp = Date.now() - 180_000;
    const secondTimestamp = firstTimestamp + 10;
    const existingRef = '[TOOL_REF id=existing tool=read type=read file=old.ts summary="already compacted"]';
    const messages = [
      { info: { role: 'user', sessionID: SESSION_ID }, parts: [{ type: 'text', text: 'previous task' }] },
      { info: { role: 'assistant', sessionID: SESSION_ID }, parts: [toolPart('read', existingRef, firstTimestamp)] },
      { info: { role: 'assistant', sessionID: SESSION_ID }, parts: [toolPart('bash', 'raw prior result', secondTimestamp)] },
      { info: { role: 'user', sessionID: SESSION_ID }, parts: [{ type: 'text', text: 'next task' }] },
    ];
    const hook = createMessagesTransformHook(runtimeContext());

    await hook({}, { messages });
    const once = messages[2].parts[0].state.output;
    await hook({}, { messages });

    strictEqual(messages[1].parts[0].state.output, existingRef);
    ok(once.startsWith('TOOL_REF'));
    strictEqual(messages[2].parts[0].state.output, once);
    strictEqual((messages[2].parts[0].state.output.match(/TOOL_REF/g) ?? []).length, 1);
  });

  it('does not compact an existing TOOL_REF when called directly', () => {
    const existingRef = '  [TOOL_REF id=direct tool=read type=read file=old.ts summary="already compacted"]';
    const compactor = new ContextCompactor({
      enabled: true,
      workingMemoryWindow: 0,
      minAgeMs: 0,
      maxOutputChars: 120,
      truncateInput: true,
      budgetCapEnabled: false,
      budgetCapPercent: 25,
      budgetCapPressureThreshold: 0.6,
      budgetCapMaxIterations: 3,
    });

    const result = compactor.compact([{
      tool: 'read',
      args: { filePath: 'old.ts' },
      output: existingRef,
      timestamp: Date.now() - 120_000,
      sessionId: SESSION_ID,
      filePath: 'old.ts',
    }]);

    strictEqual(result.compactedCount, 0);
    strictEqual(result.result.compactedParts, 0);
    strictEqual(result.result.skippedParts, 1);
    strictEqual(result.result.tokensSaved, 0);
    strictEqual(result.compacted, existingRef);
    strictEqual((result.compacted.match(/TOOL_REF/g) ?? []).length, 1);
  });

  it('fails safe when no user-turn boundary is present', async () => {
    const messages = [
      { info: { role: 'assistant', sessionID: SESSION_ID }, parts: [toolPart('read', 'must stay readable', Date.now() - 120_000)] },
    ];

    await createMessagesTransformHook(runtimeContext())({}, { messages });

    strictEqual(messages[0].parts[0].state.output, 'must stay readable');
  });
});

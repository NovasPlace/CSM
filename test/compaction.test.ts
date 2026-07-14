import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { ContextCompactor } from '../dist/context-compactor.js';
import type { ToolCallRecord } from '../dist/types.js';

const CFG = {
  workingMemoryWindow: 2,
  minAgeMs: 0,
  maxOutputChars: 200,
  enabled: true,
};

function makeToolCall(opts: Partial<ToolCallRecord> & { tool: string }): ToolCallRecord {
  return {
    sessionId: 'test-session',
    timestamp: Date.now() - (opts.ageMs ?? 0),
    tool: opts.tool,
    args: opts.args,
    output: opts.output ?? 'x'.repeat(500),
    error: opts.error,
    status: opts.status ?? 'completed',
  } as ToolCallRecord;
}

describe('ContextCompactor', () => {
  let contextCompactor: ContextCompactor;

  function makeCompactor() {
    return new ContextCompactor(CFG);
  }

  it('compacts old completed tool calls but keeps recent ones raw', () => {
    contextCompactor = makeCompactor();
    const now = Date.now();
    const toolCalls: ToolCallRecord[] = [
      makeToolCall({ tool: 'read', args: { filePath: 'a.ts' }, ageMs: 10000 }),
      makeToolCall({ tool: 'write', args: { filePath: 'b.ts' }, ageMs: 10000 }),
      makeToolCall({ tool: 'edit', args: { filePath: 'c.ts' }, ageMs: 500 }),
      makeToolCall({ tool: 'bash', args: { command: 'ls' }, ageMs: 500 }),
    ];

    const result = contextCompactor.compact(toolCalls);
    ok(result.compacted.includes('TOOL_REF'));
    strictEqual(result.result.compactedParts, 2);
    strictEqual(result.compactedCount, 2);
    ok(result.compacted.includes('TOOL_REF') && (result.compacted.includes('read') || result.compacted.includes('write')));
  });

  it('preserves running/pending tool calls regardless of age', () => {
    contextCompactor = makeCompactor();
    const toolCalls: ToolCallRecord[] = [
      makeToolCall({ tool: 'read', args: { filePath: 'a.ts' }, ageMs: 10000, status: 'running' }),
      makeToolCall({ tool: 'write', args: { filePath: 'b.ts' }, ageMs: 10000, status: 'pending' }),
    ];

    const result = contextCompactor.compact(toolCalls);
    strictEqual(result.compactedCount, 0);
    ok(result.compacted.includes('TOOL: read'));
    ok(result.compacted.includes('TOOL: write'));
  });

  it('preserves errors and warnings', () => {
    contextCompactor = makeCompactor();
    const toolCalls: ToolCallRecord[] = [
      makeToolCall({ tool: 'bash', args: { command: 'fail' }, ageMs: 10000, error: 'exit 1' }),
      makeToolCall({ tool: 'read', args: { filePath: 'a.ts' }, ageMs: 10000, output: 'warning: deprecated' }),
    ];

    const result = contextCompactor.compact(toolCalls);
    ok(result.compacted.includes('ERROR'));
    ok(result.compacted.includes('warning'));
  });

  it('keeps last N tool calls raw via workingMemoryWindow', () => {
    contextCompactor = makeCompactor();
    const toolCalls: ToolCallRecord[] = [
      makeToolCall({ tool: 'read', args: { filePath: 'a.ts' }, ageMs: 10000 }),
      makeToolCall({ tool: 'write', args: { filePath: 'b.ts' }, ageMs: 10000 }),
      makeToolCall({ tool: 'edit', args: { filePath: 'c.ts' }, ageMs: 10000 }),
    ];

    const result = contextCompactor.compact(toolCalls);
    strictEqual(result.compactedCount, 1);
  });

  it('disables compaction when enabled=false', () => {
    const disabledCompactor = new ContextCompactor({ ...CFG, enabled: false });
    const toolCalls: ToolCallRecord[] = [
      makeToolCall({ tool: 'read', args: { filePath: 'a.ts' }, ageMs: 10000 }),
    ];

    const result = disabledCompactor.compact(toolCalls);
    strictEqual(result.compactedCount, 0);
    ok(result.compacted.includes('TOOL: read'));
  });

  it('produces expandable refs for compacted tool calls', () => {
    contextCompactor = makeCompactor();
    const toolCalls: ToolCallRecord[] = [
      makeToolCall({ tool: 'read', args: { filePath: 'a.ts' }, ageMs: 10000 }),
      makeToolCall({ tool: 'write', args: { filePath: 'b.ts' }, ageMs: 10000 }),
      makeToolCall({ tool: 'edit', args: { filePath: 'c.ts' }, ageMs: 500 }),
      makeToolCall({ tool: 'bash', args: { command: 'ls' }, ageMs: 500 }),
    ];

    const result = contextCompactor.compact(toolCalls);
    ok(result.compacted.includes('TOOL_REF'));
    ok(result.compacted.includes('a.ts') || result.compacted.includes('b.ts'));
  });

  it('tracks cumulative stats', () => {
    contextCompactor = makeCompactor();
    const toolCalls: ToolCallRecord[] = [
      makeToolCall({ tool: 'read', args: { filePath: 'a.ts' }, ageMs: 10000 }),
      makeToolCall({ tool: 'write', args: { filePath: 'b.ts' }, ageMs: 10000 }),
      makeToolCall({ tool: 'edit', args: { filePath: 'c.ts' }, ageMs: 500 }),
      makeToolCall({ tool: 'bash', args: { command: 'ls' }, ageMs: 500 }),
    ];

    contextCompactor.compact(toolCalls, 'some input context that adds tokens');
    const stats = contextCompactor.getCompactionStats();
    ok(stats.totalCompactions >= 1);
    ok(stats.totalTokensSaved !== undefined);
    ok(stats.totalSemanticSignalsPreserved >= 0);
  });


  it('budget pressure compacts the oldest completed raw call first and never running calls', () => {
    const now = Date.now();
    const compactor = new ContextCompactor({
      ...CFG,
      workingMemoryWindow: 5,
      minAgeMs: 60_000,
      budgetCapEnabled: true,
      budgetCapPercent: 1,
      budgetCapPressureThreshold: 0,
      budgetCapMaxIterations: 1,
    });
    const calls = [
      { tool: 'bash', args: { command: 'long-running' }, output: 'R'.repeat(5000), timestamp: now - 5000, sessionId: 's', status: 'running' },
      { tool: 'read', args: { filePath: 'oldest.ts' }, output: 'A'.repeat(5000), timestamp: now - 4000, sessionId: 's', filePath: 'oldest.ts', status: 'completed' },
      { tool: 'read', args: { filePath: 'older.ts' }, output: 'B'.repeat(5000), timestamp: now - 3000, sessionId: 's', filePath: 'older.ts', status: 'completed' },
      { tool: 'read', args: { filePath: 'newer.ts' }, output: 'C'.repeat(5000), timestamp: now - 2000, sessionId: 's', filePath: 'newer.ts', status: 'completed' },
      { tool: 'read', args: { filePath: 'newest.ts' }, output: 'D'.repeat(5000), timestamp: now - 1000, sessionId: 's', filePath: 'newest.ts', status: 'completed' },
    ] as ToolCallRecord[];
    const messages = [{
      info: { role: 'assistant' },
      parts: calls.map(call => ({
        type: 'tool',
        tool: call.tool,
        state: {
          status: (call as ToolCallRecord & { status: string }).status,
          output: call.output,
          time: { start: call.timestamp },
        },
      })),
    }];

    const result = compactor.compact(calls, undefined, messages);

    strictEqual(result.compactedCount, 1);
    strictEqual(messages[0].parts[0].state.output, calls[0].output);
    ok(messages[0].parts[1].state.output.startsWith('TOOL_REF'));
    strictEqual(messages[0].parts.at(-1)?.state.output, calls.at(-1)?.output);
  });

  it('does not replace a tiny result with a larger TOOL_REF', () => {
    const compactor = new ContextCompactor({
      ...CFG,
      workingMemoryWindow: 0,
      minAgeMs: 0,
      budgetCapEnabled: false,
    });
    const result = compactor.compact([{
      tool: 'read',
      args: { filePath: 'a.ts' },
      output: 'ok',
      timestamp: Date.now() - 1000,
      sessionId: 's',
      filePath: 'a.ts',
    }]);

    strictEqual(result.compactedCount, 0);
    strictEqual(result.result.tokensSaved, 0);
    strictEqual(compactor.getCompactionStats().totalCompactions, 0);
  });

  it('compacts error-state content in the error field instead of adding an invalid output field', () => {
    const timestamp = Date.now() - 1000;
    const compactor = new ContextCompactor({
      ...CFG,
      workingMemoryWindow: 0,
      minAgeMs: 0,
      budgetCapEnabled: false,
    });
    const error = `failure: ${'x'.repeat(500)}`;
    const call: ToolCallRecord = {
      tool: 'bash', args: { command: 'fail' }, output: '', error,
      timestamp, sessionId: 's',
    };
    const messages = [{
      info: { role: 'assistant' },
      parts: [{ type: 'tool', tool: 'bash', state: { status: 'error', error, time: { start: timestamp } } }],
    }];

    compactor.compact([call], undefined, messages);

    ok(messages[0].parts[0].state.error.startsWith('TOOL_REF'));
    strictEqual('output' in messages[0].parts[0].state, false);
  });

  it('clears stale last-result and quality state on an empty pass', () => {
    const compactor = new ContextCompactor({
      ...CFG,
      workingMemoryWindow: 0,
      minAgeMs: 0,
      budgetCapEnabled: false,
    });
    compactor.compact([{
      tool: 'read', args: { filePath: 'a.ts' }, output: 'x'.repeat(500),
      timestamp: Date.now() - 1000, sessionId: 's', filePath: 'a.ts',
    }]);
    ok(compactor.getLastResult()?.compactedParts === 1);

    const empty = compactor.compact([]);

    strictEqual(empty.result.totalToolParts, 0);
    strictEqual(compactor.getLastResult()?.totalToolParts, 0);
    strictEqual(compactor.getLastQuality(), null);
  });


  it('rejects a compaction attempt that fails the quality gate and leaves messages untouched', () => {
    const timestamp = Date.now() - 1000;
    const compactor = new ContextCompactor({
      ...CFG,
      workingMemoryWindow: 0,
      minAgeMs: 0,
      maxOutputChars: 40,
      budgetCapEnabled: false,
    });
    const output = `${'noise '.repeat(100)} Decision: must preserve PostgreSQL. Error: migration failed. src/critical-file.ts ContextBudgetGovernor IMPORTANT_REQUIRED_TOKEN`;
    const call: ToolCallRecord = {
      tool: 'bash', args: { command: 'x' }, output,
      timestamp, sessionId: 's',
    };
    const messages = [{
      info: { role: 'assistant' },
      parts: [{ type: 'tool', tool: 'bash', state: { status: 'completed', output, time: { start: timestamp } } }],
    }];

    const result = compactor.compact([call], undefined, messages);

    strictEqual(result.compactedCount, 0);
    strictEqual(result.result.compactedParts, 0);
    strictEqual(result.result.skippedParts, 1);
    strictEqual(messages[0].parts[0].state.output, output);
    strictEqual(compactor.getLastQuality()?.safe, false);
    ok((compactor.getLastQuality()?.qualityScore ?? 1) < 0.6);
  });
});
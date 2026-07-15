import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { compileContext } from '../dist/context-compiler.js';

const config = {
  enabled: true,
  modes: { cheap: 20, normal: 20, deep: 20 },
  defaultMode: 'normal' as const,
  recentTurnWindow: 1,
  statusInjection: false,
  statusPlacement: 'end' as const,
  statusVerbosity: 'compact' as const,
  logEnabled: false,
  logSummaryRetentionDays: null,
  logDetailsRetentionDays: 1,
  storeRawCompressedContent: false,
};

describe('context compiler active-turn safety', () => {
  it('compresses old output without touching anything after the latest user message', () => {
    const oldOutput = 'old output\n'.repeat(1_000);
    const activeOutput = 'active output\n'.repeat(1_000);
    const messages = [
      { info: { role: 'assistant' }, parts: [{ type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: 'old.ts' }, output: oldOutput } }] },
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'current request' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: 'current.ts' }, output: activeOutput } }] },
    ];

    const result = compileContext(messages, config);

    ok(result.partsCompressed >= 1);
    ok(messages[0].parts[0].state.output.startsWith('[TOOL:read]'));
    strictEqual(messages[2].parts[0].state.output, activeOutput);
  });

  it('treats TOOL_REF and governor markers as terminal instead of compressing them again', () => {
    const ref = 'TOOL_REF id=call-1 fetch=context_fetch tool=read file="old.ts" summary="stored"';
    const distilled = '[TOOL_DISTILLED:read] tok=500 path=old.ts keep=stored';
    const messages = [
      { info: { role: 'assistant' }, parts: [
        { type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: 'old.ts' }, output: ref } },
        { type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: 'old.ts' }, output: distilled } },
      ] },
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'continue' }] },
    ];

    const result = compileContext(messages, config);

    strictEqual(result.partsCompressed, 0);
    strictEqual(messages[0].parts[0].state.output, ref);
    strictEqual(messages[0].parts[1].state.output, distilled);
  });

  it('does not replace a short output with a larger compiler summary', () => {
    const output = '1234567890'.repeat(4);
    const messages = [
      { info: { role: 'assistant' }, parts: [{ type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: 'very/'.repeat(50) + 'long.ts' }, output } }] },
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'continue' }] },
    ];

    const result = compileContext(messages, config);

    strictEqual(result.partsCompressed, 0);
    strictEqual(messages[0].parts[0].state.output, output);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileContext } from '../dist/context-compiler.js';
import type { ContextCompilerConfig } from '../dist/types.js';

const DEFAULT_CONFIG: ContextCompilerConfig = {
  enabled: true,
  modes: { cheap: 35000, normal: 50000, deep: 75000 },
  defaultMode: 'normal',
  recentTurnWindow: 3,
};

function toolPart(tool: string, output: string, filePath?: string) {
  return {
    type: 'tool' as const,
    tool,
    state: {
      status: 'completed',
      output,
      input: filePath
        ? { filePath, command: tool === 'bash' ? output.slice(0, 20) : undefined }
        : { command: tool === 'bash' ? 'test-cmd' : undefined },
      title: `${tool} call`,
      time: { start: 0, end: 100, duration: 100 },
    },
    callID: `call-${Math.random().toString(36).slice(2)}`,
    id: `tool-${Math.random().toString(36).slice(2)}`,
  };
}

function textPart(text: string) {
  return {
    type: 'text' as const,
    text,
    id: `text-${Math.random().toString(36).slice(2)}`,
  };
}

function msg(role: string, parts: any[]) {
  return { info: { role, id: `msg-${Math.random().toString(36).slice(2)}` }, parts };
}

function fillerMsg(n: number) {
  return msg('assistant', [textPart(`filler message ${n} with some context`)]);
}

describe('Phase 5 — Context Compiler', () => {
  it('1. disabled config returns zeroed result without modifying messages', () => {
    const parts = [textPart('hello world')];
    const messages = [msg('assistant', parts)];
    const originalText = parts[0].text;
    const result = compileContext(messages, { ...DEFAULT_CONFIG, enabled: false });
    assert.equal(result.partsCompressed, 0);
    assert.equal(result.beforeTokens, 0);
    assert.equal(result.afterTokens, 0);
    assert.equal(parts[0].text, originalText, 'no mutation');
  });

  it('2. under budget — no compression', () => {
    const parts = [textPart('short message')];
    const messages = [msg('assistant', parts)];
    const originalText = parts[0].text;
    const result = compileContext(messages, {
      ...DEFAULT_CONFIG,
      modes: { cheap: 35000, normal: 50000, deep: 75000 },
      defaultMode: 'normal',
    });
    assert.equal(result.partsCompressed, 0);
    assert.equal(result.afterTokens, result.beforeTokens);
    assert.equal(parts[0].text, originalText, 'no mutation');
  });

  it('3. over budget — compresses large old tool outputs', () => {
    const bigOutput = 'x'.repeat(5000);
    const parts = [toolPart('read', bigOutput, '/old/file.ts')];
    const messages = [
      msg('user', [textPart('do something')]),
      ...Array.from({ length: 8 }, (_, i) => fillerMsg(i)),
      msg('assistant', parts),
      msg('user', [textPart('continue')]),
      msg('assistant', [textPart('here we go')]),
    ];
    const result = compileContext(messages, {
      ...DEFAULT_CONFIG,
      modes: { cheap: 100, normal: 100, deep: 100 },
      defaultMode: 'normal',
      recentTurnWindow: 1,
    });
    assert.ok(result.partsCompressed > 0, `expected compressed parts, got ${result.partsCompressed}`);
    assert.ok(result.afterTokens < result.beforeTokens, 'tokens reduced');
    assert.ok(
      parts[0].state.output.includes('[TOOL:read]') || parts[0].state.output.includes('[COMPRESSED'),
      `output should be compressed: ${parts[0].state.output.slice(0, 100)}`
    );
  });

  it('4. user messages are never compressed (pinned)', () => {
    const bigUserText = 'x'.repeat(5000);
    const parts = [textPart(bigUserText)];
    const messages = [msg('user', parts)];
    const result = compileContext(messages, {
      ...DEFAULT_CONFIG,
      modes: { cheap: 1, normal: 1, deep: 1 },
      defaultMode: 'normal',
    });
    assert.equal(parts[0].text, bigUserText, 'user text preserved');
    assert.equal(result.partsPinned > 0, true, 'user parts were pinned');
  });

  it('5. recent turns are never compressed', () => {
    const bigOutput = 'x'.repeat(5000);
    const messages = [
      msg('user', [textPart('start')]),
      ...Array.from({ length: 5 }, (_, i) => fillerMsg(i)),
      msg('assistant', [toolPart('bash', bigOutput)]),
      msg('user', [textPart('continue')]),
      msg('assistant', [toolPart('bash', bigOutput)]),
    ];
    const result = compileContext(messages, {
      ...DEFAULT_CONFIG,
      modes: { cheap: 1, normal: 1, deep: 1 },
      defaultMode: 'normal',
    });
    assert.ok(result.partsPinned > 0, 'recent parts pinned');
  });

  it('6. compresses largest old parts first', () => {
    const smallOutput = 'small';
    const bigOutput = 'x'.repeat(8000);
    const partsSmall = [toolPart('bash', smallOutput)];
    const partsBig = [toolPart('read', bigOutput, '/big-file.ts')];
    const messages = [
      msg('user', [textPart('start')]),
      msg('assistant', partsSmall),
      ...Array.from({ length: 5 }, (_, i) => fillerMsg(i)),
      msg('assistant', partsBig),
      msg('user', [textPart('next')]),
      msg('assistant', [textPart('done')]),
    ];
    const result = compileContext(messages, {
      ...DEFAULT_CONFIG,
      modes: { cheap: 200, normal: 200, deep: 200 },
      defaultMode: 'normal',
      recentTurnWindow: 1,
    });
    assert.ok(result.partsCompressed > 0, 'compressed something');
    assert.ok(
      partsBig[0].state.output.includes('[TOOL:read]') || partsBig[0].state.output.includes('[COMPRESSED'),
      'big output was compressed'
    );
  });

  it('7. tool error parts are pinned', () => {
    const errorPart = {
      type: 'tool' as const,
      tool: 'bash',
      state: { status: 'error', error: 'Command failed', input: { command: 'bad-cmd' }, title: 'bash call', time: { start: 0, end: 100, duration: 100 } },
      callID: 'call-err',
      id: 'tool-err',
    };
    const messages = [
      msg('user', [textPart('start')]),
      msg('assistant', [errorPart]),
    ];
    const result = compileContext(messages, {
      ...DEFAULT_CONFIG,
      modes: { cheap: 1, normal: 1, deep: 1 },
      defaultMode: 'normal',
      recentTurnWindow: 0,
    });
    assert.equal(errorPart.state.error, 'Command failed', 'error preserved');
  });

  it('8. reports correct mode and budget', () => {
    const messages = [msg('assistant', [textPart('hello')])];
    const result = compileContext(messages, { ...DEFAULT_CONFIG, defaultMode: 'deep' });
    assert.equal(result.mode, 'deep');
    assert.equal(result.budget, 75000);
  });

  it('9. compresses old short tool outputs when budget is tight', () => {
    const shortOutputs = Array.from({ length: 30 }, (_, i) =>
      toolPart('bash', `result ${i}: ok`, `/old/file${i}.ts`)
    );
    const messages = [
      msg('user', [textPart('start')]),
      msg('assistant', shortOutputs),
      ...Array.from({ length: 5 }, (_, i) => fillerMsg(i)),
      msg('user', [textPart('continue')]),
      msg('assistant', [textPart('done')]),
    ];
    const result = compileContext(messages, {
      ...DEFAULT_CONFIG,
      modes: { cheap: 50, normal: 50, deep: 50 },
      defaultMode: 'normal',
      recentTurnWindow: 2,
    });
    assert.ok(result.partsCompressed > 0, `expected compressed parts, got ${result.partsCompressed}`);
  });

  it('10. adaptive window shrinks under pressure', () => {
    const shortOutputs = Array.from({ length: 20 }, (_, i) =>
      toolPart('bash', `result ${i}: ok`, `/file${i}.ts`)
    );
    const messages = [
      msg('user', [textPart('start')]),
      msg('assistant', shortOutputs.slice(0, 10)),
      ...Array.from({ length: 8 }, (_, i) => fillerMsg(i)),
      msg('assistant', shortOutputs.slice(10)),
      msg('user', [textPart('continue')]),
      msg('assistant', [textPart('finish')]),
    ];
    const lowResult = compileContext(messages, {
      ...DEFAULT_CONFIG,
      modes: { cheap: 200000, normal: 200000, deep: 200000 },
      defaultMode: 'normal',
      recentTurnWindow: 5,
    });
    const highResult = compileContext(messages, {
      ...DEFAULT_CONFIG,
      modes: { cheap: 100, normal: 100, deep: 100 },
      defaultMode: 'normal',
      recentTurnWindow: 5,
    });
    assert.ok(
      highResult.partsCompressed >= lowResult.partsCompressed,
      `high pressure should compress at least as much: high=${highResult.partsCompressed} low=${lowResult.partsCompressed}`
    );
  });

  it('11. iterative recompression when first pass insufficient', () => {
    const outputs = Array.from({ length: 40 }, (_, i) =>
      toolPart('bash', `command ${i} output: ${'x'.repeat(200)}`, `/file${i}.ts`)
    );
    const messages = [
      msg('user', [textPart('start')]),
      msg('assistant', outputs.slice(0, 20)),
      ...Array.from({ length: 8 }, (_, i) => fillerMsg(i)),
      msg('assistant', outputs.slice(20)),
      msg('user', [textPart('go')]),
      msg('assistant', [textPart('done')]),
    ];
    const result = compileContext(messages, {
      ...DEFAULT_CONFIG,
      modes: { cheap: 500, normal: 500, deep: 500 },
      defaultMode: 'normal',
      recentTurnWindow: 8,
    });
    assert.ok(result.partsCompressed > 0, 'should compress something');
    assert.ok(result.afterTokens <= result.budget * 1.05, `should fit budget: after=${result.afterTokens} budget=${result.budget}`);
  });

  it('12. preserves errors even under extreme pressure', () => {
    const errorPart = {
      type: 'tool' as const,
      tool: 'bash',
      state: { status: 'error', error: 'fatal crash', input: { command: 'build' }, title: 'bash call', time: { start: 0, end: 100, duration: 100 } },
      callID: 'call-err',
      id: 'tool-err',
    };
    const bigOutputs = Array.from({ length: 30 }, (_, i) =>
      toolPart('bash', 'x'.repeat(500), `/old${i}.ts`)
    );
    const messages = [
      msg('user', [textPart('start')]),
      msg('assistant', bigOutputs),
      msg('assistant', [errorPart]),
      msg('user', [textPart('fix it')]),
      msg('assistant', [textPart('trying')]),
    ];
    const result = compileContext(messages, {
      ...DEFAULT_CONFIG,
      modes: { cheap: 200, normal: 200, deep: 200 },
      defaultMode: 'normal',
      recentTurnWindow: 1,
    });
    assert.equal(errorPart.state.error, 'fatal crash', 'error preserved even under pressure');
  });
});

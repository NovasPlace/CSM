import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AdaptiveContextGovernor } from '../dist/context-governor.js';
import { DEFAULT_GOVERNOR_CONFIG } from '../dist/context-governor-profiles.js';
import { createMessagesTransformHook } from '../dist/hooks/messages-transform.js';
import type { PluginContext } from '../src/plugin-context.js';

const compilerConfig = {
  enabled: true, defaultMode: 'normal', recentTurnWindow: 3,
  modes: { normal: 30_000, cheap: 10_000, deep: 100_000 },
};

function runtimeContext(): PluginContext {
  return {
    config: { contextGovernor: { enabled: true } },
    contextGovernor: new AdaptiveContextGovernor(compilerConfig, {
      ...DEFAULT_GOVERNOR_CONFIG,
      thresholds: {
        lightBrief: 50, compactToolCalls: 100, checkpointRefsOnly: 150,
        distilledStateOnly: 200, emergencyRebuild: 250,
      },
    }),
    state: { currentSessionId: 'governor-audit', recentUserMessages: new Map() },
    lastCompileResult: null,
  } as unknown as PluginContext;
}

describe('governor runtime audit', () => {
  it('emits an observed governor record only after governing messages', async () => {
    const entries: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => entries.push(args.join(' '));
    try {
      await createMessagesTransformHook(runtimeContext())({}, { messages: [
        { info: { role: 'user', sessionID: 'governor-audit' }, parts: [{ type: 'text', text: 'continue' }] },
        { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'x'.repeat(2_000) }] },
      ] });
    } finally {
      console.error = original;
    }
    const audit = entries.find((entry) => entry.includes('Context governor audit'));
    assert.ok(audit);
    assert.match(audit, /event:context_governor/);
    assert.match(audit, /profile:balanced/);
    assert.match(audit, /observed_at:\d{4}-\d{2}-\d{2}T/);
  });
});

it('audits a cloned message graph and cannot rewrite the active turn', async () => {
  const ctx = runtimeContext();
  const activeOutput = `current tool result ${'z'.repeat(5_000)}`;
  const messages = [
    { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'old context '.repeat(1_000) }] },
    { info: { role: 'user', sessionID: 'governor-audit' }, parts: [{ type: 'text', text: 'current task' }] },
    {
      info: { role: 'assistant', sessionID: 'governor-audit' },
      parts: [{
        type: 'tool', tool: 'read',
        state: { status: 'completed', input: { filePath: 'src/current.ts' }, output: activeOutput, time: { start: 1 } },
      }],
    },
  ];

  await createMessagesTransformHook(ctx)({}, { messages });

  assert.equal(messages[2].parts[0].state.output, activeOutput);
  assert.equal(messages[0].parts[0].text, 'old context '.repeat(1_000));
  assert.ok(ctx.lastCompileResult);
});

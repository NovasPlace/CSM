import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveContextGovernor } from '../dist/context-governor.js';
import type { ContextCompilerConfig } from '../dist/types.js';
import { DEFAULT_GOVERNOR_CONFIG } from '../dist/context-governor-profiles.js';

const compilerConfig: ContextCompilerConfig = {
  enabled: true,
  modes: { cheap: 2_000, normal: 2_000, deep: 2_000 },
  defaultMode: 'normal',
  recentTurnWindow: 1,
  statusInjection: false,
  statusPlacement: 'end',
  statusVerbosity: 'compact',
  logEnabled: false,
  logSummaryRetentionDays: null,
  logDetailsRetentionDays: 30,
  storeRawCompressedContent: false,
};

const forcedEmergencyConfig = {
  ...DEFAULT_GOVERNOR_CONFIG,
  profiles: {
    ...DEFAULT_GOVERNOR_CONFIG.profiles,
    balanced: {
      ...DEFAULT_GOVERNOR_CONFIG.profiles.balanced,
      targetBudget: 2_000,
      maxBudget: 2_000,
      recentTurnWindow: 1,
      projectedGrowth: 0,
    },
  },
  thresholds: {
    lightBrief: 1,
    compactToolCalls: 2,
    checkpointRefsOnly: 3,
    distilledStateOnly: 4,
    emergencyRebuild: 5,
  },
} satisfies typeof DEFAULT_GOVERNOR_CONFIG;

function text(role: string, value: string) {
  return { info: { role }, parts: [{ type: 'text', text: value }] };
}

function tool(value: string) {
  return {
    info: { role: 'assistant' },
    parts: [{
      type: 'tool',
      tool: 'bash',
      state: { status: 'completed', output: value, input: { command: 'git status' } },
    }],
  };
}

describe('context governor active-turn safety', () => {
  it('recomputes the user boundary after emergency prefix replacement', () => {
    const governor = new AdaptiveContextGovernor(compilerConfig, forcedEmergencyConfig);
    const oldMessages = Array.from({ length: 30 }, (_, index) =>
      tool(`old tool ${index} ${'x'.repeat(600)}`));
    const currentOutput = `CURRENT_TOOL_OUTPUT ${'z'.repeat(2_000)}`;
    const messages = [
      ...oldMessages,
      text('user', 'inspect the current git output'),
      tool(currentOutput),
    ];

    const result = governor.govern(messages, 'balanced');

    assert.equal(result.decision.action, 'emergency_context_rebuild');
    const currentTool = messages
      .flatMap((message) => message.parts ?? [])
      .find((part) => part.type === 'tool' && String(part.state?.output ?? '').includes('CURRENT_TOOL_OUTPUT'));
    assert.ok(currentTool, 'current-turn tool part must survive the rebuild');
    assert.equal(currentTool.state?.output, currentOutput);
  });

  it('fails safe without a user boundary and reports that no rebuild occurred', () => {
    const governor = new AdaptiveContextGovernor(compilerConfig, forcedEmergencyConfig);
    const messages = Array.from({ length: 20 }, (_, index) =>
      tool(`unbounded tool ${index} ${'q'.repeat(600)}`));
    const before = JSON.stringify(messages);

    const result = governor.govern(messages, 'balanced');

    assert.equal(result.decision.action, 'emergency_context_rebuild');
    assert.equal(result.rebuildApplied, false);
    assert.equal(JSON.stringify(messages), before);
  });

});

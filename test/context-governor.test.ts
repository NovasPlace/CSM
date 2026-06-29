import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveContextGovernor } from '../dist/context-governor.js';
import { measureGovernorMetrics } from '../dist/context-governor-monitor.js';
import { DEFAULT_GOVERNOR_CONFIG } from '../dist/context-governor-profiles.js';
import type { ContextCompilerConfig } from '../dist/types.js';

const COMPILER_CONFIG: ContextCompilerConfig = {
  enabled: true,
  modes: { cheap: 35_000, normal: 60_000, deep: 100_000 },
  defaultMode: 'normal',
  recentTurnWindow: 3,
  statusInjection: true,
  statusPlacement: 'end',
  statusVerbosity: 'compact',
  logEnabled: false,
  logSummaryRetentionDays: null,
  logDetailsRetentionDays: 30,
  storeRawCompressedContent: false,
};

function text(text: string) {
  return { type: 'text' as const, text };
}

function tool(output: string) {
  return { type: 'tool' as const, tool: 'bash', state: { status: 'completed', output, input: { command: 'npm test' } } };
}

function msg(role: string, parts: any[]) {
  return { info: { role }, parts };
}

function longToolMessages(count: number, size: number) {
  return Array.from({ length: count }, (_, index) =>
    msg('assistant', [tool(`tool ${index}: ${'x'.repeat(size)}`)]));
}

function actionFor(count: number, size: number) {
  const governor = new AdaptiveContextGovernor(COMPILER_CONFIG, DEFAULT_GOVERNOR_CONFIG);
  const messages = [msg('user', [text('continue')]), ...longToolMessages(count, size)];
  return { messages, result: governor.govern(messages, 'balanced') };
}

describe('AdaptiveContextGovernor', () => {
  it('leaves low-pressure sessions alone', () => {
    const governor = new AdaptiveContextGovernor(COMPILER_CONFIG, DEFAULT_GOVERNOR_CONFIG);
    const messages = [msg('user', [text('small turn')]), msg('assistant', [text('small reply')])];
    const result = governor.govern(messages, 'balanced');
    assert.equal(result.decision.action, 'none');
    assert.equal(result.metricsAfter.totalTokens <= result.decision.budget, true);
  });

  it('compacts old tool calls when projected size crosses the 65k threshold', () => {
    const governor = new AdaptiveContextGovernor(COMPILER_CONFIG, DEFAULT_GOVERNOR_CONFIG);
    const messages = [msg('user', [text('continue')]), ...longToolMessages(48, 5000)];
    const result = governor.govern(messages, 'balanced');
    assert.equal(result.decision.action, 'compact_old_tool_calls');
    assert.equal(result.metricsAfter.totalTokens < result.metricsBefore.totalTokens, true);
  });

  it('adds a light memory brief before higher thresholds', () => {
    const { messages, result } = actionFor(36, 5000);
    const firstText = String(messages[0].parts?.[0]?.text ?? '');
    assert.equal(result.decision.action, 'light_memory_brief');
    assert.match(firstText, /\[MEMORY_BRIEF\]/);
  });

  it('replaces older history with checkpoint refs at the 75k threshold', () => {
    const governor = new AdaptiveContextGovernor(COMPILER_CONFIG, DEFAULT_GOVERNOR_CONFIG);
    const messages = [msg('user', [text('resume')]), ...longToolMessages(56, 5000)];
    const result = governor.govern(messages, 'balanced');
    const firstText = String(messages[0].parts?.[0]?.text ?? '');
    assert.equal(result.decision.action, 'checkpoint_refs_only');
    assert.match(firstText, /\[CHECKPOINT_REF\]/);
    assert.equal(result.rebuildApplied, true);
  });

  it('falls back to distilled project state before emergency rebuild', () => {
    const { messages, result } = actionFor(68, 5000);
    const firstText = String(messages[0].parts?.[0]?.text ?? '');
    assert.equal(result.decision.action, 'distilled_project_state');
    assert.match(firstText, /\[DISTILLED_STATE\]/);
  });

  it('keeps goal, phase, files, failing test, and next step during emergency rebuild', () => {
    const governor = new AdaptiveContextGovernor(COMPILER_CONFIG, DEFAULT_GOVERNOR_CONFIG);
    const messages = [
      msg('assistant', [text('Goal: Implement Phase 32 governor')]),
      msg('assistant', [text('Phase: 32')]),
      msg('assistant', [text('Files: src/context-governor.ts, test/context-governor.test.ts')]),
      msg('assistant', [text('Failed test: benchmark continuity mismatch')]),
      ...longToolMessages(120, 5000),
      msg('assistant', [text('Next step: preserve checkpoint refs during rebuild')]),
    ];
    const result = governor.govern(messages, 'balanced');
    const distilled = String(messages[0].parts?.[0]?.text ?? '');
    assert.equal(result.decision.action, 'emergency_context_rebuild');
    assert.match(distilled, /Goal: Implement Phase 32 governor/);
    assert.match(distilled, /Phase: 32/);
    assert.match(distilled, /Files: src\/context-governor\.ts/);
    assert.match(distilled, /Failed test: benchmark continuity mismatch/);
    assert.match(distilled, /Next step: preserve checkpoint refs during rebuild/);
  });

  it('reports profile budgets and monitor metrics needed for context pressure decisions', () => {
    const metrics = measureGovernorMetrics([
      msg('assistant', [text('[MEMORY_BRIEF] summary')]),
      msg('assistant', [text('[CHECKPOINT_REF] ref')]),
      msg('assistant', [text('[DISTILLED_STATE] state')]),
      msg('assistant', [tool('tool output')]),
    ], DEFAULT_GOVERNOR_CONFIG.profiles.balanced.projectedGrowth);
    assert.equal(DEFAULT_GOVERNOR_CONFIG.profiles.cheap.targetBudget, 35_000);
    assert.equal(DEFAULT_GOVERNOR_CONFIG.profiles.balanced.targetBudget, 60_000);
    assert.equal(DEFAULT_GOVERNOR_CONFIG.profiles.deep_work.targetBudget, 100_000);
    assert.equal(DEFAULT_GOVERNOR_CONFIG.profiles.emergency.targetBudget, 12_000);
    assert.equal(metrics.memoryBriefTokens > 0, true);
    assert.equal(metrics.checkpointRefTokens > 0, true);
    assert.equal(metrics.distilledStateTokens > 0, true);
    assert.equal(metrics.toolOutputTokens > 0, true);
    assert.equal(metrics.rawMessagesKept, 4);
    assert.equal(metrics.projectedNextTurnTokens > metrics.totalTokens, true);
    assert.equal(metrics.toolOutputShare > 0, true);
  });

  it('distills stale tool output and deduplicates repeated old context', () => {
    const governor = new AdaptiveContextGovernor(COMPILER_CONFIG, DEFAULT_GOVERNOR_CONFIG);
    const repeated = 'Repeated status block '.repeat(80);
    const messages = [
      msg('assistant', [text(repeated)]),
      msg('assistant', [tool(`tool 1 ${'x'.repeat(1600)}`)]),
      msg('assistant', [text('older filler context')]),
      msg('assistant', [text(repeated)]),
      msg('assistant', [tool(`tool 2 ${'x'.repeat(1600)}`)]),
      msg('assistant', [text('newer filler context')]),
      msg('user', [text('continue with latest errors only')]),
      msg('assistant', [text('recent tail stays raw')]),
    ];
    governor.govern(messages, 'balanced');
    assert.match(String(messages[3].parts?.[0]?.text ?? ''), /\[DEDUP_REF\]/);
    assert.match(String(messages[1].parts?.[0]?.state?.output ?? ''), /\[TOOL_DISTILLED:bash\]/);
  });

  it('collapses repeated stale tool signatures into tiny refs', () => {
    const governor = new AdaptiveContextGovernor(COMPILER_CONFIG, DEFAULT_GOVERNOR_CONFIG);
    const output = `read src/example.ts ${'x'.repeat(1600)}`;
    const messages = [
      msg('assistant', [tool(output)]),
      msg('assistant', [text('older filler')]),
      msg('assistant', [tool(output)]),
      msg('assistant', [text('newer filler')]),
      msg('user', [text('continue')]),
      msg('assistant', [text('recent tail stays raw')]),
    ];
    governor.govern(messages, 'balanced');
    assert.match(String(messages[0].parts?.[0]?.state?.output ?? ''), /\[TOOL_DISTILLED:bash\]/);
    assert.match(String(messages[2].parts?.[0]?.state?.output ?? ''), /\[(TOOL_DEDUP_REF:bash|DEDUP_REF)\]/);
  });
});

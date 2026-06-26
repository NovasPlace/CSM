import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CompactionAnalytics, DEFAULT_PROVIDER_PRICING } from '../dist/compaction-analytics.js';
import type { CompileResult } from '../dist/context-compiler.js';
import type { ProviderPricing } from '../dist/types.js';

function makeResult(overrides: Partial<CompileResult> = {}): CompileResult {
  return {
    beforeTokens: 100000,
    afterTokens: 19766,
    budget: 20000,
    partsCompressed: 5,
    partsPinned: 2,
    mode: 'normal',
    compressedDetails: [
      { kind: 'tool_bash', source: 'test', tokensBefore: 500, tokensAfter: 20, compressionRatio: 0.04, risk: 'low', preservedSignals: ['file_paths'], reason: 'old_tool_output' },
      { kind: 'tool_bash', source: 'build', tokensBefore: 800, tokensAfter: 30, compressionRatio: 0.0375, risk: 'low', preservedSignals: ['command'], reason: 'old_tool_output' },
      { kind: 'tool_read', source: '/src/foo.ts', tokensBefore: 2000, tokensAfter: 50, compressionRatio: 0.025, risk: 'low', preservedSignals: ['file_paths'], reason: 'large_tool_output' },
      { kind: 'tool_bash', source: 'test-cmd', tokensBefore: 100, tokensAfter: 10, compressionRatio: 0.1, risk: 'medium', preservedSignals: ['command', 'exit_code'], reason: 'pressure_compressed' },
      { kind: 'tool_bash', source: 'deploy', tokensBefore: 1500, tokensAfter: 40, compressionRatio: 0.0267, risk: 'high', preservedSignals: ['error_content', 'file_paths', 'command'], reason: 'compressible_critical' },
    ],
    pinnedCategories: { recent_turn: 1, critical_raw: 1 },
    ...overrides,
  };
}

function makeMessages(toolTokenShare: number, totalTokens: number) {
  const toolTokens = Math.floor(totalTokens * toolTokenShare);
  const otherTokens = totalTokens - toolTokens;
  const perPartTokens = 125;
  const toolParts = Math.ceil(toolTokens / perPartTokens);
  const otherParts = Math.ceil(otherTokens / perPartTokens);
  const charsPerPart = perPartTokens * 4;
  const parts: any[] = [];
  for (let i = 0; i < toolParts; i++) parts.push({ type: 'tool', state: { output: 'x'.repeat(charsPerPart) } });
  for (let i = 0; i < otherParts; i++) parts.push({ type: 'text', text: 'y'.repeat(charsPerPart) });
  return [{ info: { role: 'assistant' }, parts }];
}

describe('CompactionAnalytics', () => {
  it('1. report includes tokensBefore/tokensAfter/tokensSaved/reductionPercent', () => {
    const analytics = new CompactionAnalytics();
    const result = makeResult({ beforeTokens: 100000, afterTokens: 19766 });
    const report = analytics.recordCompaction(result, makeMessages(0.876, 100000), 'sess_1');
    assert.equal(report.tokensBefore, 100000);
    assert.equal(report.tokensAfter, 19766);
    assert.equal(report.tokensSaved, 80234);
    assert.ok(Math.abs(report.reductionPercent - 80.234) < 0.01, `reductionPercent ${report.reductionPercent} != 80.234`);
  });

  it('2. report includes toolTokensBefore/toolTokensAfter/toolDominanceBefore/toolDominanceAfter', () => {
    const analytics = new CompactionAnalytics();
    const messages = makeMessages(0.876, 100000);
    const result = makeResult({ beforeTokens: 100000, afterTokens: 19766 });
    const report = analytics.recordCompaction(result, messages, 'sess_1');
    assert.ok(report.toolTokensBefore > 0, 'should have tool tokens before');
    assert.ok(report.toolDominanceBefore > 0.5, `tool dominance before ${report.toolDominanceBefore} should be > 0.5`);
    assert.ok(report.toolDominanceAfter < report.toolDominanceBefore, 'tool dominance should drop after compaction');
  });

  it('3. report includes compressionCount and qualityScore', () => {
    const analytics = new CompactionAnalytics();
    const report = analytics.recordCompaction(makeResult(), makeMessages(0.8, 100000), 'sess_1');
    assert.equal(report.compressionCount, 5);
    assert.ok(report.qualityScore >= 0 && report.qualityScore <= 1, `qualityScore ${report.qualityScore} out of range`);
  });

  it('4. report includes unsafeCompactionsRejected count', () => {
    const analytics = new CompactionAnalytics({ unsafeRejectCount: 2 });
    const report = analytics.recordCompaction(makeResult(), makeMessages(0.8, 100000), 'sess_1');
    assert.equal(report.unsafeCompactionsRejected, 2);
  });

  it('5. report includes effectiveContextMultiplier', () => {
    const analytics = new CompactionAnalytics();
    const report = analytics.recordCompaction(makeResult(), makeMessages(0.8, 100000), 'sess_1');
    assert.ok(report.effectiveContextMultiplier >= 1, `multiplier ${report.effectiveContextMultiplier} should be >= 1`);
  });

  it('6. cost savings use provider-configurable pricing', () => {
    const customPricing: ProviderPricing = { inputPerMtok: 10, outputPerMtok: 30, cacheWritePerMtok: 2.5, cacheReadPerMtok: 0.5 };
    const analytics = new CompactionAnalytics({ pricing: customPricing });
    const result = makeResult({ beforeTokens: 100000, afterTokens: 19766 });
    const report = analytics.recordCompaction(result, makeMessages(0.8, 100000), 'sess_1');
    assert.ok(report.estimatedCostSaved > 0, 'should have cost savings with custom pricing');
    const expectedSaving = (80234 / 1_000_000) * 10;
    assert.ok(Math.abs(report.estimatedCostSaved - expectedSaving) < 0.01, `cost ${report.estimatedCostSaved} != ${expectedSaving}`);
  });

  it('7. missing provider price data degrades safely to zero cost savings', () => {
    const zeroPricing: ProviderPricing = { inputPerMtok: 0, outputPerMtok: 0, cacheWritePerMtok: 0, cacheReadPerMtok: 0 };
    const analytics = new CompactionAnalytics({ pricing: zeroPricing });
    const result = makeResult({ beforeTokens: 100000, afterTokens: 19766 });
    const report = analytics.recordCompaction(result, makeMessages(0.8, 100000), 'sess_1');
    assert.equal(report.estimatedCostSaved, 0);
  });

  it('8. no analytics write breaks compaction — recordCompaction never throws', () => {
    const analytics = new CompactionAnalytics();
    let threw = false;
    try {
      analytics.recordCompaction(makeResult(), [], 'sess_1');
      analytics.recordCompaction(makeResult(), undefined as any, 'sess_1');
      analytics.recordCompaction({} as any, makeMessages(0.8, 10000), 'sess_1');
    } catch { threw = true; }
    assert.equal(threw, false, 'analytics should never throw');
  });

  it('9. session summary aggregates multiple cycles', () => {
    const analytics = new CompactionAnalytics();
    analytics.recordCompaction(makeResult({ beforeTokens: 50000, afterTokens: 10000 }), makeMessages(0.9, 50000), 'sess_1');
    analytics.recordCompaction(makeResult({ beforeTokens: 40000, afterTokens: 12000 }), makeMessages(0.85, 40000), 'sess_1');
    const summary = analytics.getSessionSummary('sess_1');
    assert.ok(summary, 'should return session summary');
    assert.equal(summary!.totalCycles, 2);
    assert.equal(summary!.totalTokensSaved, 68000);
    assert.ok(summary!.avgReductionPercent > 0);
  });

  it('10. tool-dominance trend tracks improvement across cycles', () => {
    const analytics = new CompactionAnalytics();
    analytics.recordCompaction(makeResult({ beforeTokens: 50000, afterTokens: 10000 }), makeMessages(0.9, 50000), 'sess_1');
    analytics.recordCompaction(makeResult({ beforeTokens: 40000, afterTokens: 10000 }), makeMessages(0.85, 40000), 'sess_1');
    analytics.recordCompaction(makeResult({ beforeTokens: 30000, afterTokens: 10000 }), makeMessages(0.8, 30000), 'sess_1');
    const summary = analytics.getSessionSummary('sess_1');
    const trend = summary!.toolDominanceTrend;
    assert.equal(trend.length, 3);
    assert.ok(trend[0].before > trend[2].before, 'dominance before should decrease over cycles');
  });
});

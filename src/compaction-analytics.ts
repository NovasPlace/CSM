import type { CompactionReport, SessionAnalytics, ProviderPricing, BudgetMode, CompressedPartDetail, ToolDominanceTrendPoint } from './types.js';
import type { CompileResult } from './context-compiler.js';
import { estimateTokens } from './token-bucket-analyzer.js';

export const DEFAULT_PROVIDER_PRICING: ProviderPricing = {
  inputPerMtok: 3,
  outputPerMtok: 15,
  cacheWritePerMtok: 3.75,
  cacheReadPerMtok: 0.3,
};

function countToolTokens(messages: { parts?: any[] }[] | undefined): number {
  if (!messages || !Array.isArray(messages)) return 0;
  let tokens = 0;
  for (const msg of messages) {
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      if (part.type === 'tool') {
        tokens += estimateTokens(String(part.state?.output ?? part.text ?? ''));
      }
    }
  }
  return tokens;
}

function countTotalTokens(messages: { parts?: any[] }[] | undefined): number {
  if (!messages || !Array.isArray(messages)) return 0;
  let tokens = 0;
  for (const msg of messages) {
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      tokens += estimateTokens(String(part.text ?? part.state?.output ?? ''));
    }
  }
  return tokens;
}

function computeSimplifiedQuality(details: CompressedPartDetail[] | null, before: number, after: number): number {
  if (!details || details.length === 0) return 1.0;
  const highRiskCount = details.filter(d => d.risk === 'high').length;
  const highRiskRatio = highRiskCount / details.length;
  const reduction = before > 0 ? (before - after) / before : 0;
  return Math.max(0, Math.min(1, reduction * (1 - highRiskRatio * 0.5)));
}

function generateCycleId(): string {
  return `cycle_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

interface AnalyticsConfig {
  pricing?: ProviderPricing;
  unsafeRejectCount?: number;
}

export class CompactionAnalytics {
  private sessions: Map<string, SessionAnalytics> = new Map();
  private pricing: ProviderPricing;
  private unsafeRejectCount: number;

  constructor(config: AnalyticsConfig = {}) {
    this.pricing = config.pricing ?? DEFAULT_PROVIDER_PRICING;
    this.unsafeRejectCount = config.unsafeRejectCount ?? 0;
  }

  recordCompaction(
    compileResult: CompileResult,
    messagesBefore: { parts?: any[] }[] | undefined,
    sessionId: string,
    budget: number = 20000,
    budgetMode: BudgetMode = 'normal',
  ): CompactionReport {
    try {
      return this._recordCompaction(compileResult, messagesBefore, sessionId, budget, budgetMode);
    } catch {
      return this._emptyReport(compileResult, sessionId, budget, budgetMode);
    }
  }

  private _recordCompaction(
    compileResult: CompileResult,
    messagesBefore: { parts?: any[] }[] | undefined,
    sessionId: string,
    budget: number,
    budgetMode: BudgetMode,
  ): CompactionReport {
    const beforeTokens = compileResult.beforeTokens;
    const afterTokens = compileResult.afterTokens;
    const tokensSaved = beforeTokens - afterTokens;
    const reductionPercent = beforeTokens > 0 ? (tokensSaved / beforeTokens) * 100 : 0;
    const pressureRatio = budget > 0 ? beforeTokens / budget : 1;

    const totalBefore = countTotalTokens(messagesBefore);
    const toolTokensBefore = countToolTokens(messagesBefore);
    const toolDominanceBefore = totalBefore > 0 ? toolTokensBefore / totalBefore : 0;

    const toolTokensAfter = compileResult.afterTokens > 0 && toolDominanceBefore > 0
      ? Math.floor(compileResult.afterTokens * toolDominanceBefore * (1 - (compileResult.partsCompressed / Math.max(compileResult.partsCompressed + compileResult.partsPinned, 1))))
      : 0;
    const totalAfter = compileResult.afterTokens;
    const toolDominanceAfter = totalAfter > 0 ? toolTokensAfter / totalAfter : 0;

    const qualityScore = computeSimplifiedQuality(
      compileResult.compressedDetails,
      beforeTokens,
      afterTokens,
    );

    const effectiveContextMultiplier = budget > 0
      ? beforeTokens / budget
      : 1;

    const tokensSavedForCost = Math.max(0, tokensSaved);
    const estimatedCostSaved = (tokensSavedForCost / 1_000_000) * this.pricing.inputPerMtok;

    const report: CompactionReport = {
      sessionId,
      cycleId: generateCycleId(),
      timestamp: new Date(),
      tokensBefore: beforeTokens,
      tokensAfter: afterTokens,
      tokensSaved,
      reductionPercent,
      toolTokensBefore,
      toolTokensAfter,
      toolDominanceBefore,
      toolDominanceAfter,
      compressionCount: compileResult.partsCompressed,
      unsafeCompactionsRejected: this.unsafeRejectCount,
      qualityScore,
      estimatedCostSaved,
      effectiveContextMultiplier,
      budgetMode,
      budget,
      pressureRatio,
      details: compileResult.compressedDetails,
      providerPricing: this.pricing,
    };

    const session = this._getOrCreateSession(sessionId);
    session.reports.push(report);
    session.totalTokensSaved += tokensSaved;
    session.totalCycles += 1;
    session.totalUnsafeRejected = this.unsafeRejectCount;
    session.avgReductionPercent = session.reports.reduce((sum, r) => sum + r.reductionPercent, 0) / session.reports.length;
    session.totalCostSaved += estimatedCostSaved;
    session.avgQualityScore = session.reports.reduce((sum, r) => sum + r.qualityScore, 0) / session.reports.length;
    session.peakPressureRatio = Math.max(session.peakPressureRatio, pressureRatio);
    session.effectiveContextMultiplier = effectiveContextMultiplier;
    session.toolDominanceTrend.push({
      cycle: session.totalCycles,
      before: toolDominanceBefore,
      after: toolDominanceAfter,
    });

    return report;
  }

  getSessionSummary(sessionId: string): SessionAnalytics | null {
    return this.sessions.get(sessionId) ?? null;
  }

  private _getOrCreateSession(sessionId: string): SessionAnalytics {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        totalCycles: 0,
        totalTokensSaved: 0,
        totalCostSaved: 0,
        totalUnsafeRejected: 0,
        avgQualityScore: 1,
        avgReductionPercent: 0,
        peakPressureRatio: 0,
        effectiveContextMultiplier: 1,
        toolDominanceTrend: [],
        reports: [],
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private _emptyReport(compileResult: CompileResult, sessionId: string, budget: number, budgetMode: BudgetMode): CompactionReport {
    return {
      sessionId,
      cycleId: generateCycleId(),
      timestamp: new Date(),
      tokensBefore: compileResult?.beforeTokens ?? 0,
      tokensAfter: compileResult?.afterTokens ?? 0,
      tokensSaved: 0,
      reductionPercent: 0,
      toolTokensBefore: 0,
      toolTokensAfter: 0,
      toolDominanceBefore: 0,
      toolDominanceAfter: 0,
      compressionCount: 0,
      unsafeCompactionsRejected: 0,
      qualityScore: 1,
      estimatedCostSaved: 0,
      effectiveContextMultiplier: 1,
      budgetMode,
      budget,
      pressureRatio: budget > 0 ? (compileResult?.beforeTokens ?? 0) / budget : 1,
      details: null,
    };
  }
}

export { countToolTokens };

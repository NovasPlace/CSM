import type { ReEntryBudgetDecision } from './reentry-adaptive-budget.js';
import { computeReentryTrimLevel, estimateTokens } from './reentry-budget-allocator.js';
import type {
  LayerDetail,
  ReEntryConfig,
  ReEntryDiagnostic,
  ReEntryLayerResult,
} from './reentry-types.js';

export function buildReentryDiagnostic(
  results: ReEntryLayerResult[],
  budget: ReEntryBudgetDecision,
): ReEntryDiagnostic {
  const surviving = results.filter((result) => !result.dropped);
  const totalChars = surviving.reduce((sum, result) => sum + result.chars, 0);
  return {
    layersBuilt: surviving.map((result) => result.name),
    layersTrimmed: results.filter((result) => result.trimmed && !result.dropped).map((result) => result.name),
    layersDropped: results.filter((result) => result.dropped).map((result) => result.name),
    totalChars,
    originalChars: results.reduce((sum, result) => sum + result.originalChars, 0),
    budgetChars: budget.effectiveMaxChars,
    budgetTier: budget.tier,
    priorSessionTurns: budget.priorTurnCount,
    approxTokens: estimateTokens(totalChars),
    trimLevel: computeReentryTrimLevel(results),
    sources: Object.fromEntries(surviving.map((result) => [result.name, result.sources])),
    enabled: true,
    layerDetails: results.map(toLayerDetail),
  };
}

export function disabledReentryDiagnostic(config: ReEntryConfig): ReEntryDiagnostic {
  return {
    layersBuilt: [], layersTrimmed: [], layersDropped: [], totalChars: 0, originalChars: 0,
    budgetChars: config.maxChars, budgetTier: 'unknown', priorSessionTurns: null,
    approxTokens: 0, trimLevel: 'none', sources: {}, enabled: false, layerDetails: [],
  };
}

function toLayerDetail(result: ReEntryLayerResult): LayerDetail {
  return {
    name: result.name,
    priority: result.priority,
    status: result.dropped ? 'dropped' : result.trimmed ? 'trimmed' : 'included',
    originalChars: result.originalChars,
    finalChars: result.chars,
    approxTokens: estimateTokens(result.chars),
    trimReason: result.trimReason,
    sources: result.sources,
  };
}

import {
  BUILDER_VERSION,
  computeConfigHash,
  type BuiltContextInjection,
  type ContextInjectionItem,
  type ContextInjectionLayerSummary,
} from './context-injection-contract.js';
import type { ReEntryConfig, ReEntryLayerResult } from './reentry-types.js';
import type { ReEntryBudgetDecision } from './reentry-adaptive-budget.js';

export function buildReentryProvenance(
  results: ReEntryLayerResult[],
  config: ReEntryConfig,
  text: string,
  trimLevel: BuiltContextInjection['trimLevel'],
  sessionId: string,
  projectId: string,
  budget: ReEntryBudgetDecision,
): BuiltContextInjection {
  return {
    text, injectionKind: 'reentry', items: provenanceItems(results), layers: layerSummaries(results),
    charCount: text.length, estimatedTokens: Math.ceil(text.length / 4), trimLevel,
    builderVersion: BUILDER_VERSION, configHash: computeConfigHash(reentryConfigRecord(config)),
    metadata: {
      sessionId,
      projectId,
      budgetTier: budget.tier,
      priorSessionTurns: budget.priorTurnCount,
      effectiveMaxChars: budget.effectiveMaxChars,
    },
  };
}

function provenanceItems(results: ReEntryLayerResult[]): ContextInjectionItem[] {
  return results.map((result) => ({
    layerName: result.name, sourceKind: 'derived_state', sourceId: `reentry-layer:${result.name}`,
    memoryId: null, position: 0, selectionRank: result.priority, selectionScore: null,
    selectionReason: selectionReason(result), disposition: result.dropped ? 'omitted' : result.trimmed ? 'trimmed' : 'injected',
    provenanceGranularity: 'layer', charCount: result.chars,
    metadata: { sourceCount: result.sources.length, trimReason: result.trimReason },
  }));
}

function selectionReason(result: ReEntryLayerResult): ContextInjectionItem['selectionReason'] {
  if (!result.trimmed && !result.dropped) return null;
  if (result.trimReason === 'empty_source' || result.trimReason === 'missing_source') return 'empty_source';
  return 'budget_trim';
}

function layerSummaries(results: ReEntryLayerResult[]): ContextInjectionLayerSummary[] {
  return results.map((result) => ({
    layerName: result.name, status: result.dropped ? 'dropped' : result.trimmed ? 'trimmed' : 'included',
    originalChars: result.originalChars, finalChars: result.chars, itemCount: 1, trimReason: result.trimReason,
  }));
}

function reentryConfigRecord(config: ReEntryConfig): Record<string, unknown> {
  return { enabled: config.enabled, maxChars: config.maxChars, previewOnly: config.previewOnly,
    minLayerChars: config.minLayerChars, layers: config.layers.join(',') };
}

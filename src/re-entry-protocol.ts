import type { BuiltContextInjection } from './context-injection-contract.js';
import { buildReentryProvenance } from './reentry-injection-provenance.js';
import {
  resolveAdaptiveReentryBudget,
  type ReEntryBudgetDecision,
} from './reentry-adaptive-budget.js';
import { getLogger } from './logger.js';
import { ReentryLayerBuilder } from './reentry-layer-builder.js';
import type { ReentryLayerDependencies } from './reentry-layer-types.js';
import {
  applyLayerBudget,
  computeReentryTrimLevel,
  estimateTokens,
} from './reentry-budget-allocator.js';
import {
  DEFAULT_REENTRY_CONFIG,
  LAYER_SPECS,
  REENTRY_HEADER,
  type LayerDetail,
  type ReEntryConfig,
  type ReEntryDiagnostic,
  type ReEntryLayerResult,
  type TrimReason,
} from './reentry-types.js';
import {
  buildReentryDiagnostic,
  disabledReentryDiagnostic,
} from './reentry-diagnostic.js';

export { applyLayerBudget, computeReentryTrimLevel, estimateTokens };
export { DEFAULT_REENTRY_CONFIG };
export type {
  LayerDetail,
  ReEntryConfig,
  ReEntryDiagnostic,
  ReEntryLayerResult,
  TrimReason,
};

interface ReEntryProtocolDependencies extends ReentryLayerDependencies {
  config?: Partial<ReEntryConfig>;
}

export class ReEntryProtocol {
  private readonly deps: ReentryLayerDependencies;
  private readonly layers: ReentryLayerBuilder;
  private readonly config: ReEntryConfig;

  constructor(deps: ReEntryProtocolDependencies) {
    this.deps = deps;
    this.layers = new ReentryLayerBuilder(deps);
    this.config = { ...DEFAULT_REENTRY_CONFIG, ...deps.config };
  }

  async buildBlock(sessionId: string, projectId: string): Promise<string | null> {
    if (!this.config.enabled) return null;
    try {
      const block = await this.buildRenderedBlock(sessionId, projectId);
      if (block === null || this.config.previewOnly) {
        getLogger().debug('Re-entry block built (preview-only or empty)', { sessionId });
        return null;
      }
      return block;
    } catch (error) {
      getLogger().error('Re-entry block build failed', asError(error));
      return null;
    }
  }

  async buildBlockForSourceOnlyTurn(sessionId: string, projectId: string): Promise<string | null> {
    if (!this.config.enabled) return null;
    try {
      return await this.buildRenderedBlock(sessionId, projectId);
    } catch (error) {
      getLogger().error('Source-only re-entry block build failed', asError(error));
      return null;
    }
  }

  async buildBlockWithProvenance(
    sessionId: string,
    projectId: string,
  ): Promise<BuiltContextInjection | null> {
    if (!this.config.enabled || this.config.previewOnly) return null;
    try {
      const { budgeted, budget } = await this.assembleBudgetedLayers(sessionId, projectId);
      const text = renderBlock(budgeted);
      return text === null ? null : buildReentryProvenance(
        budgeted,
        this.config,
        text,
        computeReentryTrimLevel(budgeted),
        sessionId,
        projectId,
        budget,
      );
    } catch (error) {
      getLogger().error('Re-entry provenance block build failed', asError(error));
      return null;
    }
  }

  async diagnose(sessionId: string, projectId: string): Promise<ReEntryDiagnostic> {
    if (!this.config.enabled) return disabledReentryDiagnostic(this.config);
    const { budgeted, budget } = await this.assembleBudgetedLayers(sessionId, projectId);
    return buildReentryDiagnostic(budgeted, budget);
  }

  private async assembleBudgetedLayers(
    sessionId: string,
    projectId: string,
  ): Promise<{ budgeted: ReEntryLayerResult[]; budget: ReEntryBudgetDecision }> {
    const [results, budget] = await Promise.all([
      this.assembleLayers(sessionId, projectId),
      resolveAdaptiveReentryBudget(this.deps.pool, this.config, sessionId, projectId),
    ]);
    return {
      budgeted: applyLayerBudget(results, { ...this.config, maxChars: budget.effectiveMaxChars }),
      budget,
    };
  }

  private async assembleLayers(sessionId: string, projectId: string): Promise<ReEntryLayerResult[]> {
    const results: ReEntryLayerResult[] = [];
    for (const layerName of this.config.layers) {
      const spec = LAYER_SPECS[layerName];
      if (!spec) continue;
      if (!this.layers.hasSource(layerName)) {
        results.push(emptyLayer(layerName, spec.priority, spec.budget, 'missing_source'));
        continue;
      }
      results.push(await this.buildLayer(layerName, sessionId, projectId));
    }
    return results;
  }

  private async buildLayer(
    layerName: string,
    sessionId: string,
    projectId: string,
  ): Promise<ReEntryLayerResult> {
    const spec = LAYER_SPECS[layerName];
    try {
      const built = await this.layers.build(layerName, sessionId, projectId);
      return populatedLayer(layerName, spec.priority, spec.budget, built.text, built.sources);
    } catch (error) {
      const reason = error instanceof TypeError ? 'missing_source' : 'degraded_source';
      getLogger().warn(`Re-entry layer ${layerName} build failed (${reason})`, {});
      return emptyLayer(layerName, spec.priority, spec.budget, reason);
    }
  }

  private async buildRenderedBlock(sessionId: string, projectId: string): Promise<string | null> {
    const { budgeted } = await this.assembleBudgetedLayers(sessionId, projectId);
    return renderBlock(budgeted);
  }
}

function populatedLayer(
  name: string,
  priority: number,
  budget: number,
  text: string,
  sources: string[],
): ReEntryLayerResult {
  const empty = text.trim() === '';
  return {
    name, priority, budget, text, sources,
    originalChars: text.length,
    chars: text.length,
    trimmed: false,
    dropped: empty,
    trimReason: empty ? 'empty_source' : null,
  };
}

function emptyLayer(
  name: string,
  priority: number,
  budget: number,
  trimReason: TrimReason,
): ReEntryLayerResult {
  return {
    name, priority, budget, trimReason,
    originalChars: 0, chars: 0, text: '',
    trimmed: false, dropped: true, sources: [],
  };
}

function renderBlock(results: ReEntryLayerResult[]): string | null {
  const text = results.filter((result) => !result.dropped && result.text.length > 0)
    .map((result) => result.text);
  return text.length === 0 ? null : `<agent_reentry_context>\n${REENTRY_HEADER}\n\n${text.join('\n\n')}\n</agent_reentry_context>`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

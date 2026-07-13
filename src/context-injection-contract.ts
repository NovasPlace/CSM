/**
 * Context Injection Contract — structured provenance for context injection.
 *
 * Commit 2 scope: define the contract types only. No telemetry writes,
 * no schema interaction, no hook wiring. Builders emit provenance
 * alongside existing text; the rendered text path is unchanged.
 */

export type InjectionKind = 'reentry' | 'onboarding' | 'context_brief' | 'advisory';

export type ItemDisposition = 'injected' | 'trimmed' | 'omitted';

export type ProvenanceGranularity = 'item' | 'layer';

export type ItemSourceKind = 'memory' | 'document_section' | 'derived_state';

export type SelectionReasonCode =
  | 'importance_rank'
  | 'recent_session'
  | 'explicit_preference'
  | 'active_goal'
  | 'budget_trim'
  | 'layer_budget_exhausted'
  | 'filter_rejection'
  | 'empty_source';

export interface ContextInjectionItem {
  readonly layerName: string;
  readonly sourceKind: ItemSourceKind;
  readonly sourceId: string;
  readonly memoryId: number | null;
  readonly position: number;
  readonly selectionRank: number | null;
  readonly selectionScore: number | null;
  readonly selectionReason: SelectionReasonCode | null;
  readonly disposition: ItemDisposition;
  readonly provenanceGranularity: ProvenanceGranularity;
  readonly charCount: number;
  readonly metadata: Record<string, unknown>;
}

export interface ContextInjectionLayerSummary {
  readonly layerName: string;
  readonly status: 'included' | 'trimmed' | 'dropped';
  readonly originalChars: number;
  readonly finalChars: number;
  readonly itemCount: number;
  readonly trimReason: string | null;
}

export interface BuiltContextInjection {
  readonly text: string;
  readonly injectionKind: InjectionKind;
  readonly items: ContextInjectionItem[];
  readonly layers: ContextInjectionLayerSummary[];
  readonly charCount: number;
  readonly estimatedTokens: number;
  readonly trimLevel: 'none' | 'soft' | 'aggressive';
  readonly builderVersion: string;
  readonly configHash: string;
  readonly metadata: Record<string, unknown>;
}

export const BUILDER_VERSION = 'reentry-v2-provenance-1';

export function computeConfigHash(config: Record<string, unknown>): string {
  const keys = Object.keys(config).sort();
  const parts = keys.map((k) => `${k}=${String(config[k])}`);
  const raw = parts.join(',');
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  return `cfg_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function validateBuiltContextInjection(
  built: BuiltContextInjection,
): string[] {
  const errors: string[] = [];

  if (typeof built.text !== 'string') {
    errors.push('text must be a string');
  }

  const seen = new Set<string>();
  for (const item of built.items) {
    const key = `${item.layerName}:${item.position}`;
    if (seen.has(key)) {
      errors.push(`duplicate (layerName, position): ${key}`);
    }
    seen.add(key);

    if (!['injected', 'trimmed', 'omitted'].includes(item.disposition)) {
      errors.push(`invalid disposition: ${item.disposition}`);
    }

    if (!['item', 'layer'].includes(item.provenanceGranularity)) {
      errors.push(`invalid provenanceGranularity: ${item.provenanceGranularity}`);
    }

    if (item.sourceKind === 'memory' && item.memoryId === null) {
      errors.push(`memory sourceKind with null memoryId at ${key}`);
    }

    if (item.sourceKind !== 'memory' && item.memoryId !== null) {
      errors.push(`non-memory sourceKind with non-null memoryId at ${key}`);
    }
  }

  return errors;
}

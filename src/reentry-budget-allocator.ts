import {
  LAYER_ORDER,
  LAYER_SPECS,
  type ReEntryConfig,
  type ReEntryLayerResult,
  type ReEntryTrimLevel,
} from './reentry-types.js';

interface Allocation {
  layer: ReEntryLayerResult;
  target: number;
}

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export function computeReentryTrimLevel(results: ReEntryLayerResult[]): ReEntryTrimLevel {
  const budgetDrop = results.some((result) => result.dropped
    && (result.trimReason === 'over_budget' || result.trimReason === 'below_min_layer_chars'));
  if (budgetDrop) return 'aggressive';
  return results.some((result) => result.trimmed) ? 'soft' : 'none';
}

export function applyLayerBudget(
  results: ReEntryLayerResult[],
  config: ReEntryConfig,
): ReEntryLayerResult[] {
  const working = results.map((result) => ({ ...result }));
  const total = working.reduce((sum, result) => sum + result.originalChars, 0);
  if (total <= config.maxChars) return normalizeWithinBudget(working);
  return allocateOverBudget(working, config);
}

function normalizeWithinBudget(results: ReEntryLayerResult[]): ReEntryLayerResult[] {
  for (const result of results) {
    if (result.trimReason !== null) continue;
    if (LAYER_SPECS[result.name]?.neverTrim) result.trimReason = 'protected_layer';
    else if (result.dropped) result.trimReason = sourceDropReason(result);
    else if (result.originalChars === 0 || result.text.trim() === '') {
      Object.assign(result, { dropped: true, chars: 0, text: '', trimReason: 'empty_source' });
    }
  }
  return sortLayers(results);
}

function allocateOverBudget(
  results: ReEntryLayerResult[],
  config: ReEntryConfig,
): ReEntryLayerResult[] {
  const output = initialOutput(results);
  const protectedChars = output
    .filter((result) => result.trimReason === 'protected_layer')
    .reduce((sum, result) => sum + result.originalChars, 0);
  const remaining = config.maxChars - protectedChars;
  const candidates = activeCandidates(results, output);
  if (remaining <= 0) return sortLayers([...output, ...dropAll(candidates, 'over_budget')]);
  if (totalChars(candidates) <= remaining) return sortLayers([...output, ...includeAll(candidates)]);
  const survivors = dropUntilFloorsFit(candidates, remaining, config, output);
  return sortLayers([...output, ...materialize(allocateSurplus(survivors, remaining, config))]);
}

function initialOutput(results: ReEntryLayerResult[]): ReEntryLayerResult[] {
  const output: ReEntryLayerResult[] = [];
  for (const result of results) {
    if (LAYER_SPECS[result.name]?.neverTrim && !result.dropped) {
      output.push({ ...result, trimReason: 'protected_layer' });
    } else if (result.dropped) {
      output.push({ ...result, trimReason: result.trimReason ?? sourceDropReason(result) });
    }
  }
  return output;
}

function activeCandidates(
  results: ReEntryLayerResult[],
  output: ReEntryLayerResult[],
): ReEntryLayerResult[] {
  const candidates = results
    .filter((result) => !result.dropped && !LAYER_SPECS[result.name]?.neverTrim)
    .sort((left, right) => right.priority - left.priority);
  return candidates.filter((result) => {
    if (result.originalChars > 0 && result.text.trim() !== '') return true;
    output.push({ ...result, dropped: true, text: '', chars: 0, trimReason: 'empty_source' });
    return false;
  });
}

function dropUntilFloorsFit(
  candidates: ReEntryLayerResult[],
  remaining: number,
  config: ReEntryConfig,
  output: ReEntryLayerResult[],
): ReEntryLayerResult[] {
  let survivors = [...candidates];
  while (survivors.length > 0 && totalFloors(survivors, config) > remaining) {
    const dropped = survivors.at(-1) as ReEntryLayerResult;
    output.push({ ...dropped, dropped: true, text: '', chars: 0, trimReason: 'below_min_layer_chars' });
    survivors = survivors.slice(0, -1);
  }
  return survivors;
}

function allocateSurplus(
  survivors: ReEntryLayerResult[],
  remaining: number,
  config: ReEntryConfig,
): Allocation[] {
  const allocations = survivors.map((layer) => ({ layer, target: floorOf(layer, config) }));
  let surplus = remaining - allocations.reduce((sum, item) => sum + item.target, 0);
  const priorityTotal = allocations.reduce((sum, item) => sum + item.layer.priority, 0);
  for (const item of allocations) {
    const share = priorityTotal > 0 ? Math.floor((surplus * item.layer.priority) / priorityTotal) : 0;
    item.target += Math.min(item.layer.originalChars - item.target, share);
  }
  surplus = remaining - allocations.reduce((sum, item) => sum + item.target, 0);
  for (const item of allocations) {
    const extra = Math.min(item.layer.originalChars - item.target, surplus);
    item.target += extra;
    surplus -= extra;
  }
  return allocations;
}

function materialize(allocations: Allocation[]): ReEntryLayerResult[] {
  return allocations.map(({ layer, target }) => {
    if (target >= layer.originalChars) {
      return { ...layer, chars: layer.originalChars, trimmed: false, trimReason: null };
    }
    const text = layer.text.substring(0, target).trimEnd();
    return { ...layer, text, chars: text.length, trimmed: true, trimReason: 'over_budget' };
  });
}

function floorOf(result: ReEntryLayerResult, config: ReEntryConfig): number {
  return Math.min(result.originalChars, Math.max(result.budget, config.minLayerChars));
}

function totalFloors(results: ReEntryLayerResult[], config: ReEntryConfig): number {
  return results.reduce((sum, result) => sum + floorOf(result, config), 0);
}

function totalChars(results: ReEntryLayerResult[]): number {
  return results.reduce((sum, result) => sum + result.originalChars, 0);
}

function includeAll(results: ReEntryLayerResult[]): ReEntryLayerResult[] {
  return results.map((result) => ({ ...result, chars: result.originalChars, trimmed: false, trimReason: null }));
}

function dropAll(
  results: ReEntryLayerResult[],
  trimReason: ReEntryLayerResult['trimReason'],
): ReEntryLayerResult[] {
  return results.map((result) => ({ ...result, dropped: true, text: '', chars: 0, trimReason }));
}

function sourceDropReason(result: ReEntryLayerResult): 'missing_source' | 'degraded_source' {
  return result.originalChars === 0 ? 'missing_source' : 'degraded_source';
}

function sortLayers(results: ReEntryLayerResult[]): ReEntryLayerResult[] {
  return results.sort((left, right) => order(left.name) - order(right.name));
}

function order(name: string): number {
  const index = LAYER_ORDER.indexOf(name);
  return index === -1 ? 999 : index;
}

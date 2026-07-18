import type { Database } from './database.js';
import type { MemorySearchOptions } from './types.js';
import {
  checkFtsAvailable,
  entityMatchBoost,
  ftsSearch,
  vectorSearch,
} from './hybrid-search-sources.js';
import {
  applyWeights,
  computeRecencyScores,
  deduplicateByContent,
  reciprocalRankFusion,
} from './hybrid-search-ranking.js';
import { DEFAULT_WEIGHTS, type HybridWeights } from './hybrid-search-types.js';

export { entityMatchBoost, ftsSearch, vectorSearch } from './hybrid-search-sources.js';
export {
  applyWeights,
  jaccardSimilarity,
  recencyScoreForAge,
  reciprocalRankFusion,
} from './hybrid-search-ranking.js';
export { DEFAULT_WEIGHTS, type HybridWeights } from './hybrid-search-types.js';

export async function hybridSearch(
  db: Database,
  query: string,
  embedding: number[],
  limit: number,
  options: Omit<MemorySearchOptions, 'query'> & { weights?: HybridWeights } = {},
): Promise<Array<{ id: number; score: number }>> {
  const searchLimit = limit * 3;
  const filters = [
    options.projectId, options.type, options.tags, options.minImportance, options.searchMode,
  ] as const;
  const [vectorResults, textResults, entityResults] = await Promise.all([
    vectorSearch(db, embedding, searchLimit, ...filters),
    searchText(db, query, searchLimit, filters),
    entityMatchBoost(db, query, searchLimit, ...filters),
  ]);
  const vectorScores = reciprocalRankFusion(vectorResults);
  const textScores = reciprocalRankFusion(textResults);
  const entityScores = new Map(entityResults.map(result => [result.id, result.boost]));
  const candidateIds = new Set([...vectorScores.keys(), ...textScores.keys(), ...entityScores.keys()]);
  const recencyScores = await computeRecencyScores(db, [...candidateIds]);
  const scores = applyWeights(
    vectorScores,
    textScores,
    entityScores,
    recencyScores,
    options.weights ?? DEFAULT_WEIGHTS,
  );
  const ranked = [...scores].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const deduplicated = await deduplicateByContent(db, ranked);
  return deduplicated.slice(0, limit).map(([id, score]) => ({ id, score }));
}

async function searchText(
  db: Database,
  query: string,
  limit: number,
  filters: readonly [
    string | undefined,
    string | undefined,
    string[] | undefined,
    number | undefined,
    'project' | 'legacy' | 'global' | undefined,
  ],
) {
  if (!await checkFtsAvailable(db)) return [];
  return ftsSearch(db, query, limit, ...filters);
}

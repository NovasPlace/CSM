import type { Database } from './database.js';
import {
  DEFAULT_WEIGHTS,
  RECENCY_HALF_LIFE_HOURS,
  type HybridWeights,
  type RankedId,
} from './hybrid-search-types.js';

export function reciprocalRankFusion(...rankings: RankedId[][]): Map<number, number> {
  const scores = new Map<number, number>();
  for (const ranking of rankings) {
    for (const entry of ranking) scores.set(entry.id, (scores.get(entry.id) ?? 0) + entry.rank);
  }
  return scores;
}

export function applyWeights(
  vectorScores: Map<number, number>,
  textScores: Map<number, number>,
  entityBoosts: Map<number, number>,
  recencyScores: Map<number, number>,
  weights: HybridWeights = DEFAULT_WEIGHTS,
): Map<number, number> {
  const vector = normalize(vectorScores);
  const text = normalize(textScores);
  const entity = normalize(entityBoosts);
  const ids = new Set([...vector.keys(), ...text.keys(), ...entity.keys(), ...recencyScores.keys()]);
  const final = new Map<number, number>();
  for (const id of ids) {
    const score = (vector.get(id) ?? 0) * weights.vector
      + (text.get(id) ?? 0) * weights.text
      + (entity.get(id) ?? 0) * weights.entity
      + clamp(recencyScores.get(id) ?? 0) * weights.recency;
    final.set(id, score);
  }
  return final;
}

function normalize(scores: Map<number, number>): Map<number, number> {
  const maximum = Math.max(0, ...scores.values());
  if (maximum === 0) return new Map(scores);
  return new Map([...scores].map(([id, score]) => [id, clamp(score / maximum)]));
}

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }

export function recencyScoreForAge(ageHours: number): number {
  return Math.exp((-Math.LN2 * Math.max(0, ageHours)) / RECENCY_HALF_LIFE_HOURS);
}

export async function computeRecencyScores(
  db: Database,
  candidateIds: number[],
  now = Date.now(),
): Promise<Map<number, number>> {
  if (candidateIds.length === 0) return new Map();
  const placeholders = candidateIds.map((_, index) => `$${index + 1}`).join(',');
  try {
    const result = await db.getPool().query(
      `SELECT id, created_at FROM memories WHERE id IN (${placeholders})`,
      candidateIds,
    );
    return new Map((result.rows as Array<{ id: number; created_at: string }>).map(row => {
      const ageHours = (now - new Date(row.created_at).getTime()) / 3_600_000;
      return [row.id, recencyScoreForAge(ageHours)];
    }));
  } catch {
    return new Map();
  }
}

export async function deduplicateByContent(
  db: Database,
  ranked: Array<[number, number]>,
): Promise<Array<[number, number]>> {
  if (ranked.length === 0) return ranked;
  const contents = await fetchContents(db, ranked.map(([id]) => id));
  if (!contents) return ranked;
  const kept: Array<{ id: number; score: number; content?: string }> = [];
  for (const [id, score] of ranked) {
    const content = contents.get(id);
    const duplicate = content !== undefined
      && kept.some(item => item.content !== undefined && jaccardSimilarity(item.content, content) >= 0.85);
    if (!duplicate) kept.push({ id, score, content });
  }
  return kept.map(item => [item.id, item.score]);
}

async function fetchContents(db: Database, ids: number[]): Promise<Map<number, string> | null> {
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(',');
  try {
    const result = await db.getPool().query(
      `SELECT id, content FROM memories WHERE id IN (${placeholders})`,
      ids,
    );
    return new Map((result.rows as Array<{ id: number; content: string }>).map(row => [row.id, row.content]));
  } catch {
    return null;
  }
}

export function jaccardSimilarity(first: string, second: string): number {
  const firstTokens = tokens(first);
  const secondTokens = tokens(second);
  let intersection = 0;
  for (const token of firstTokens) if (secondTokens.has(token)) intersection++;
  const union = firstTokens.size + secondTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function tokens(content: string): Set<string> {
  return new Set(content.toLowerCase().split(/\s+/).filter(Boolean));
}

import { Database } from "./database.js";
import type { MemorySearchOptions } from "./types.js";
import { ilikeExpr, jsonContainsParam, jsonExtractValue } from "./db/query-dialect.js";

export type HybridWeights = {
  vector: number;
  text: number;
  entity: number;
  recency: number;
};

const DEFAULT_WEIGHTS: HybridWeights = {
  vector: 0.35,
  text: 0.25,
  entity: 0.35,
  recency: 0.05,
};

const RRF_K = 60;

function buildWhereClause(
  params: unknown[],
  projectId?: string,
  type?: string,
  tags?: string[],
  minImportance?: number,
): string {
  let paramIdx = params.length + 1;
  const clauses: string[] = [];
  if (projectId) {
    clauses.push(`project_id = $${paramIdx}`);
    params.push(projectId);
    paramIdx++;
  }
  if (type) {
    clauses.push(`memory_type = $${paramIdx}`);
    params.push(type);
    paramIdx++;
  }
  if (tags && tags.length > 0) {
    clauses.push(`tags && $${paramIdx}`);
    params.push(tags);
    paramIdx++;
  }
  if (minImportance !== undefined) {
    clauses.push(`importance >= $${paramIdx}`);
    params.push(minImportance);
    paramIdx++;
  }
  return clauses.length > 0 ? 'AND ' + clauses.join(' AND ') : '';
}

export async function ftsSearch(
  db: Database,
  query: string,
  limit: number,
  projectId?: string,
  type?: string,
  tags?: string[],
  minImportance?: number,
): Promise<Array<{ id: number; rank: number }>> {
  const pool = db.getPool();
  try {
    const params: unknown[] = [query, limit];
    const whereExtra = buildWhereClause(params, projectId, type, tags, minImportance);
    const result = await pool.query(
      `SELECT id, ts_rank_cd(search_vector, websearch_to_tsquery('english', $1)) AS rank
       FROM memories
       WHERE search_vector @@ websearch_to_tsquery('english', $1)
         ${whereExtra}
       ORDER BY rank DESC
       LIMIT $2`,
      params,
    );
    return result.rows.map((r: any, i: number) => ({ id: r.id, rank: 1 / (RRF_K + i + 1) }));
  } catch {
    return [];
  }
}

export async function vectorSearch(
  db: Database,
  embedding: number[],
  limit: number,
  projectId?: string,
  type?: string,
  tags?: string[],
  minImportance?: number,
): Promise<Array<{ id: number; rank: number }>> {
  const pool = db.getPool();
  const params: unknown[] = [JSON.stringify(embedding), limit];
  const whereExtra = buildWhereClause(params, projectId, type, tags, minImportance);
  const result = await pool.query(
    `SELECT id, 1 - (embedding <=> $1::vector) AS similarity
     FROM memories
     WHERE embedding IS NOT NULL
       ${whereExtra}
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    params,
  );
  return result.rows.map((r: any, i: number) => ({ id: r.id, rank: 1 / (RRF_K + i + 1) }));
}

export async function entityMatchBoost(
  db: Database,
  query: string,
  limit: number,
  projectId?: string,
  type?: string,
  tags?: string[],
  minImportance?: number,
): Promise<Array<{ id: number; boost: number }>> {
  const pool = db.getPool();
  const d = db.dialect;
  const like = `%${query.replace(/[%_]/g, '\\$&')}%`;
  const conceptsJson = JSON.stringify([query]);
  try {
    const params: unknown[] = [like, conceptsJson];
    const whereExtra = buildWhereClause(params, projectId, type, tags, minImportance);
    const result = await pool.query(
      `SELECT id,
        CASE
          WHEN ${ilikeExpr(d, 'content', 1)} THEN 2.0
          WHEN ${jsonContainsParam(d, jsonExtractValue(d, 'metadata', 'extracted_concepts'), 2)} THEN 1.8
          WHEN ${ilikeExpr(d, 'tags::text', 1)} THEN 1.5
          ELSE 0.0
        END AS boost
       FROM memories
       WHERE (${ilikeExpr(d, 'content', 1)}
              OR ${ilikeExpr(d, 'tags::text', 1)}
              OR ${jsonContainsParam(d, jsonExtractValue(d, 'metadata', 'extracted_concepts'), 2)})
         ${whereExtra}
       LIMIT ${limit}`,
      params,
    );
    return result.rows.map((r: any) => ({ id: r.id, boost: r.boost }));
  } catch {
    return [];
  }
}

export function reciprocalRankFusion(
  ...rankings: Array<Array<{ id: number; rank: number }>>
): Map<number, number> {
  const scores = new Map<number, number>();
  for (const ranking of rankings) {
    for (const entry of ranking) {
      scores.set(entry.id, (scores.get(entry.id) ?? 0) + entry.rank);
    }
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
  const allIds = new Set<number>([
    ...vectorScores.keys(),
    ...textScores.keys(),
    ...entityBoosts.keys(),
    ...recencyScores.keys(),
  ]);
  const final = new Map<number, number>();
  for (const id of allIds) {
    const v = vectorScores.get(id) ?? 0;
    const t = textScores.get(id) ?? 0;
    const e = entityBoosts.get(id) ?? 0;
    const r = recencyScores.get(id) ?? 0;
    final.set(id, v * weights.vector + t * weights.text + e * weights.entity + r * weights.recency);
  }
  return final;
}

export async function hybridSearch(
  db: Database,
  query: string,
  embedding: number[],
  limit: number,
  options: Omit<MemorySearchOptions, 'query'> & { weights?: HybridWeights } = {},
): Promise<Array<{ id: number; score: number }>> {
  const projectId = options.projectId;
  const type = options.type;
  const tags = options.tags;
  const minImportance = options.minImportance;
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  const ftsAvailable = await checkFtsAvailable(db);

    let textScores: Map<number, number>;

  // Vector search (always available)
  const vectorResults = await vectorSearch(db, embedding, limit * 3, projectId, type, tags, minImportance);
  const vectorScores = reciprocalRankFusion(vectorResults);

  // FTS search (may be unavailable)
  if (ftsAvailable) {
    const ftsResults = await ftsSearch(db, query, limit * 3, projectId, type, tags, minImportance);
    textScores = reciprocalRankFusion(ftsResults);
  } else {
    textScores = new Map();
  }

   // Entity boost
   const entityResults = await entityMatchBoost(db, query, limit * 3, projectId, type, tags, minImportance);
   const entityBoosts = new Map(entityResults.map((e) => [e.id, e.boost]));

  // Recency boost (prefer recent memories)
  const recencyScores = new Map<number, number>();

  // Merge with weights
  const final = applyWeights(vectorScores, textScores, entityBoosts, recencyScores, weights);

  // Sort by score descending, take top limit
  return Array.from(final.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, score]) => ({ id, score }));
}

async function checkFtsAvailable(db: Database): Promise<boolean> {
  try {
    const pool = db.getPool();
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'memories' AND column_name = 'search_vector'
       LIMIT 1`,
    );
    return result.rows.length > 0;
  } catch {
    return false;
  }
}

export { DEFAULT_WEIGHTS };

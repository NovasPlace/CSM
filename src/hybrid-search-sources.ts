import type { Database } from './database.js';
import type { MemorySearchMode } from './types.js';
import {
  ilikeExpr,
  jsonArrayContains,
  jsonParam,
} from './db/query-dialect.js';
import type { QueryDialect } from './db/query-dialect.js';
import { RRF_K, type BoostedId, type RankedId } from './hybrid-search-types.js';

interface SearchRow { id: number; boost?: number }

function buildWhereClause(
  dialect: QueryDialect,
  params: unknown[],
  projectId?: string,
  type?: string,
  tags?: string[],
  minImportance?: number,
  searchMode: MemorySearchMode = 'project',
): string {
  const clauses: string[] = [];
  appendProjectScope(clauses, params, projectId, searchMode);
  appendFilter(clauses, params, 'memory_type', type);
  if (tags?.length) {
    params.push(jsonParam(dialect, tags));
    clauses.push(jsonArrayContains(dialect, 'tags', params.length));
  }
  if (minImportance !== undefined) {
    params.push(minImportance);
    clauses.push(`importance >= $${params.length}`);
  }
  return clauses.length ? `AND ${clauses.join(' AND ')}` : '';
}

function appendProjectScope(
  clauses: string[],
  params: unknown[],
  projectId: string | undefined,
  searchMode: MemorySearchMode,
): void {
  if (searchMode === 'global') return;
  if (searchMode === 'legacy') {
    if (!projectId) { clauses.push('project_id IS NULL'); return; }
    params.push(projectId);
    clauses.push(`(project_id = $${params.length} OR project_id IS NULL)`);
    return;
  }
  if (!projectId) {
    clauses.push('1=0');
    return;
  }
  appendFilter(clauses, params, 'project_id', projectId);
}

function appendFilter(
  clauses: string[],
  params: unknown[],
  column: string,
  value?: string,
): void {
  if (!value) return;
  params.push(value);
  clauses.push(`${column} = $${params.length}`);
}

export async function ftsSearch(
  db: Database,
  query: string,
  limit: number,
  projectId?: string,
  type?: string,
  tags?: string[],
  minImportance?: number,
  searchMode?: MemorySearchMode,
): Promise<RankedId[]> {
  try {
    const params: unknown[] = [query, limit];
    const filters = buildWhereClause(db.dialect, params, projectId, type, tags, minImportance, searchMode);
    const result = await db.getPool().query(
      `SELECT id, ts_rank_cd(search_vector, websearch_to_tsquery('english', $1)) AS rank
       FROM memories WHERE search_vector @@ websearch_to_tsquery('english', $1)
       ${filters} ORDER BY rank DESC, id ASC LIMIT $2`,
      params,
    );
    return rankRows(result.rows as SearchRow[]);
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
  searchMode?: MemorySearchMode,
): Promise<RankedId[]> {
  const params: unknown[] = [JSON.stringify(embedding), limit];
  const filters = buildWhereClause(db.dialect, params, projectId, type, tags, minImportance, searchMode);
  const result = await db.getPool().query(
    `SELECT id, 1 - (embedding <=> $1::vector) AS similarity FROM memories
     WHERE embedding IS NOT NULL ${filters}
     ORDER BY embedding <=> $1::vector, id ASC LIMIT $2`,
    params,
  );
  return rankRows(result.rows as SearchRow[]);
}

export async function entityMatchBoost(
  db: Database,
  query: string,
  limit: number,
  projectId?: string,
  type?: string,
  tags?: string[],
  minImportance?: number,
  searchMode?: MemorySearchMode,
): Promise<BoostedId[]> {
  try {
    const escapedQuery = query.replace(/\\/g, '\\\\').replace(/[%_]/g, '\\$&');
    const escaped = `%${escapedQuery}%`;
    const params: unknown[] = [escaped];
    const filters = buildWhereClause(db.dialect, params, projectId, type, tags, minImportance, searchMode);
    params.push(limit);
    const boost = entityBoostExpression(db.dialect);
    const match = entityMatchExpression(db.dialect);
    const result = await db.getPool().query(
      `SELECT id, ${boost} AS boost FROM memories
       WHERE (${match}) ${filters} ORDER BY boost DESC, id ASC LIMIT $${params.length}`,
      params,
    );
    return (result.rows as SearchRow[]).map(row => ({ id: row.id, boost: Number(row.boost ?? 0) }));
  } catch {
    return [];
  }
}

function entityBoostExpression(dialect: QueryDialect): string {
  const tags = dialect === 'sqlite' ? 'tags' : 'tags::text';
  return `CASE WHEN ${ilikeExpr(dialect, 'content', 1)} THEN 2.0
    WHEN ${conceptMatchExpression(dialect)} THEN 1.8
    WHEN ${ilikeExpr(dialect, tags, 1)} THEN 1.5 ELSE 0.0 END`;
}

function entityMatchExpression(dialect: QueryDialect): string {
  const tags = dialect === 'sqlite' ? 'tags' : 'tags::text';
  return `${ilikeExpr(dialect, 'content', 1)} OR ${ilikeExpr(dialect, tags, 1)}
    OR ${conceptMatchExpression(dialect)}`;
}

function conceptMatchExpression(dialect: QueryDialect): string {
  if (dialect === 'sqlite') {
    return `EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(metadata, '$.extracted_concepts'), '[]')) AS concept
      WHERE LOWER(json_extract(concept.value, '$.value')) LIKE LOWER($1))`;
  }
  return `EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(metadata->'extracted_concepts', '[]'::jsonb)) AS concept
    WHERE concept->>'value' ILIKE $1)`;
}

function rankRows(rows: SearchRow[]): RankedId[] {
  return rows.map((row, index) => ({ id: row.id, rank: 1 / (RRF_K + index + 1) }));
}

export async function checkFtsAvailable(db: Database): Promise<boolean> {
  if (db.dialect === 'sqlite') return false;
  try {
    const result = await db.getPool().query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'memories' AND column_name = 'search_vector' LIMIT 1`,
    );
    return result.rows.length > 0;
  } catch {
    return false;
  }
}

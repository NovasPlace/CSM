import type { QueryDialect } from './db/query-dialect.js';
import { jsonExtractText, parseArrayField, parseJsonField, toDate } from './db/query-dialect.js';
import type { Memory } from './types.js';
import type { SnapshotOptions, WikiQueryClient } from './wiki-export-model.js';

interface MemoryQuery { sql: string; params: unknown[] }

export function buildMemoryQuery(dialect: QueryDialect, options: SnapshotOptions): MemoryQuery {
  const params: unknown[] = [];
  const conditions: string[] = [];
  appendProjectCondition(conditions, params, options.projectId);
  appendTypeCondition(conditions, params, options.memoryTypesFilter);
  appendModeCondition(conditions, params, dialect, options);
  const suffix = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return {
    sql: `SELECT * FROM memories ${suffix} ORDER BY memory_type ASC, importance DESC, id ASC`,
    params,
  };
}

function appendProjectCondition(conditions: string[], params: unknown[], projectId?: string): void {
  if (!projectId) return;
  params.push(projectId);
  conditions.push(`project_id = $${params.length}`);
}

function appendTypeCondition(
  conditions: string[],
  params: unknown[],
  memoryTypes?: SnapshotOptions['memoryTypesFilter'],
): void {
  if (!memoryTypes?.length) return;
  const placeholders = memoryTypes.map(type => {
    params.push(type);
    return `$${params.length}`;
  });
  conditions.push(`memory_type IN (${placeholders.join(',')})`);
}

function appendModeCondition(
  conditions: string[],
  params: unknown[],
  dialect: QueryDialect,
  options: SnapshotOptions,
): void {
  if (options.mode === 'full') return;
  params.push(options.importanceThreshold);
  const threshold = `$${params.length}`;
  const sourceKind = jsonExtractText(dialect, 'metadata', 'source_kind');
  const promotionSource = jsonExtractText(dialect, 'metadata', 'promotion_source');
  conditions.push([
    "memory_type IN ('lesson', 'procedural')",
    `(memory_type = 'preference' AND ${sourceKind} = 'decision')`,
    `${promotionSource} = 'belief_promotion_engine'`,
    `(memory_type IN ('workspace', 'repo') AND importance >= ${threshold})`,
    `(memory_type IN ('episodic', 'conversation') AND importance >= ${threshold})`,
  ].join(' OR '));
}

export async function selectMemories(
  client: WikiQueryClient,
  dialect: QueryDialect,
  options: SnapshotOptions,
): Promise<Memory[]> {
  const query = buildMemoryQuery(dialect, options);
  const result = await client.query(query.sql, query.params);
  return (result.rows as Record<string, unknown>[]).map(row => mapMemory(row, dialect));
}

export async function selectMemoriesByIds(
  client: WikiQueryClient,
  dialect: QueryDialect,
  ids: number[],
): Promise<Memory[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(',');
  const result = await client.query(
    `SELECT * FROM memories WHERE id IN (${placeholders}) ORDER BY id ASC`,
    ids,
  );
  return (result.rows as Record<string, unknown>[]).map(row => mapMemory(row, dialect));
}

function mapMemory(row: Record<string, unknown>, dialect: QueryDialect): Memory {
  return {
    id: Number(row.id),
    sessionId: row.session_id as string | undefined,
    projectId: row.project_id as string | undefined,
    memoryType: row.memory_type as Memory['memoryType'],
    content: String(row.content ?? ''),
    importance: Number(row.importance ?? 0),
    emotion: (row.emotion ?? 'neutral') as Memory['emotion'],
    confidence: Number(row.confidence ?? 1),
    source: (row.source ?? 'auto') as Memory['source'],
    tags: parseArrayField(dialect, row.tags) as string[],
    linkedMemoryIds: parseArrayField(dialect, row.linked_memory_ids) as number[],
    metadata: parseJsonField(dialect, row.metadata),
    createdAt: toDate(dialect, row.created_at),
    updatedAt: toDate(dialect, row.updated_at),
    accessedAt: toDate(dialect, row.accessed_at),
    accessCount: Number(row.access_count ?? 0),
  };
}

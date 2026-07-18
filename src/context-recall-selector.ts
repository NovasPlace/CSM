import type { DatabasePool, Memory } from './types.js';

type RecallTier = 'episodic' | 'procedural' | 'semantic';

export class ContextRecallSelector {
  private readonly pool: DatabasePool;
  private readonly recent = new Map<RecallTier, Set<number>>();
  private projectId: string | null = null;

  constructor(pool: DatabasePool) {
    this.pool = pool;
  }

  setProject(projectId: string | null): void {
    if (this.projectId !== projectId) this.recent.clear();
    this.projectId = projectId;
  }

  episodic(): Promise<Memory[]> {
    return this.select(
      'episodic',
      `memory_type IN ('episodic', 'conversation')
       AND created_at > NOW() - INTERVAL '6 hours'`,
      'created_at DESC, id DESC',
      20,
    );
  }

  procedural(): Promise<Memory[]> {
    return this.select(
      'procedural',
      `memory_type IN ('lesson', 'procedural')`,
      'importance DESC, accessed_at DESC, id DESC',
      10,
    );
  }

  semantic(): Promise<Memory[]> {
    return this.select(
      'semantic',
      `memory_type IN ('workspace', 'repo', 'preference')`,
      'importance DESC, updated_at DESC, id DESC',
      10,
    );
  }

  private async select(
    tier: RecallTier,
    predicate: string,
    orderBy: string,
    limit: number,
  ): Promise<Memory[]> {
    const excluded = [...(this.recent.get(tier) ?? [])];
    let rows = await this.query(predicate, orderBy, limit, excluded);
    if (rows.length === 0 && excluded.length > 0) {
      this.recent.delete(tier);
      rows = await this.query(predicate, orderBy, limit, []);
    }
    this.record(tier, rows);
    return rows;
  }

  private async query(
    predicate: string,
    orderBy: string,
    limit: number,
    excluded: number[],
  ): Promise<Memory[]> {
    const params: unknown[] = [];
    const project = this.projectId ? `AND project_id = $${push(params, this.projectId)}` : '';
    const rotation = excluded.length > 0
      ? `AND NOT (id = ANY($${push(params, excluded)}::bigint[]))`
      : '';
    const result = await this.pool.query(
      `SELECT * FROM memories WHERE ${predicate} ${project} ${rotation}
       ORDER BY ${orderBy} LIMIT ${limit}`,
      params,
    );
    return result.rows.map((row) => mapMemory(row as Record<string, unknown>));
  }

  private record(tier: RecallTier, memories: Memory[]): void {
    const ids = this.recent.get(tier) ?? new Set<number>();
    for (const memory of memories) ids.add(memory.id);
    while (ids.size > 200) ids.delete(ids.values().next().value as number);
    this.recent.set(tier, ids);
  }
}

function push(params: unknown[], value: unknown): number {
  params.push(value);
  return params.length;
}

function mapMemory(row: Record<string, unknown>): Memory {
  return {
    id: Number(row.id),
    sessionId: row.session_id as string | undefined,
    projectId: row.project_id as string | undefined,
    memoryType: row.memory_type as Memory['memoryType'],
    content: String(row.content ?? ''),
    importance: Number(row.importance ?? 0),
    emotion: row.emotion as Memory['emotion'],
    confidence: Number(row.confidence ?? 1),
    source: row.source as Memory['source'],
    tags: (row.tags ?? []) as string[],
    linkedMemoryIds: (row.linked_memory_ids ?? []) as number[],
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    accessedAt: new Date(row.accessed_at as string),
    accessCount: Number(row.access_count ?? 0),
  };
}

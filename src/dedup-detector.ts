import type { Database } from './database.js';

export interface DedupDetectorConfig {
  similarityThreshold?: number;
  maxClusters?: number;
  allowedTypes?: string[];
  includeDifferentTypes?: boolean;
  projectId?: string;
}

export interface DedupMemoryRef {
  id: number;
  content: string;
  memoryType: string;
  title: string;
  createdAt: string;
}

export interface DedupCluster {
  representative: DedupMemoryRef;
  duplicateIds: number[];
  clusterSize: number;
  averageSimilarity: number;
  detectionMethod: 'exact_content' | 'exact_title' | 'embedding_similarity';
}

export interface DedupReport {
  clusters: DedupCluster[];
  totalCandidates: number;
  memoriesScanned: number;
  thresholdUsed: number;
}

export class DedupCandidateDetector {
  private pool: ReturnType<Database['getPool']>;

  constructor(
    database: Database,
    private config: DedupDetectorConfig = {},
  ) {
    this.pool = database.getPool();
  }

  async findCandidates(overrideConfig?: DedupDetectorConfig): Promise<DedupReport> {
    const cfg = { ...this.config, ...overrideConfig };
    const threshold = cfg.similarityThreshold ?? 0.92;
    const maxClusters = cfg.maxClusters ?? 50;
    const projectId = cfg.projectId;
    const allowedTypes = cfg.allowedTypes;

    const memories = await this.fetchMemories(projectId, allowedTypes);
    const clusteredIds = new Set<number>();
    const clusters: DedupCluster[] = [];

    const contentClusters = this.groupByExactContent(memories, clusteredIds);
    clusters.push(...contentClusters);

    const titleClusters = this.groupByExactTitle(memories, clusteredIds);
    clusters.push(...titleClusters);

    const unclustered = memories.filter(m => !clusteredIds.has(m.id));
    const embedClusters = await this.groupByEmbeddingSimilarity(unclustered, threshold, clusteredIds);
    clusters.push(...embedClusters);

    return {
      clusters: clusters.slice(0, maxClusters),
      totalCandidates: memories.length,
      memoriesScanned: memories.length,
      thresholdUsed: threshold,
    };
  }

  private async fetchMemories(
    projectId?: string,
    allowedTypes?: string[],
  ): Promise<DedupMemoryRef[]> {
    let sql = `SELECT id, content, memory_type, COALESCE(metadata->>'title', '') AS title,
                      created_at::text AS created_at
               FROM memories WHERE embedding IS NOT NULL`;
    const params: unknown[] = [];
    let paramIdx = 0;

    if (projectId) {
      paramIdx++;
      sql += ` AND project_id = $${paramIdx}`;
      params.push(projectId);
    }

    if (allowedTypes && allowedTypes.length > 0) {
      paramIdx++;
      sql += ` AND memory_type = ANY($${paramIdx})`;
      params.push(allowedTypes);
    }

    sql += ' ORDER BY id ASC';

    const result = await this.pool.query(sql, params.length > 0 ? params : undefined);
    return (result.rows as Array<{
      id: number; content: string; memory_type: string; title: string; created_at: string;
    }>).map(r => ({
      id: r.id,
      content: r.content,
      memoryType: r.memory_type,
      title: r.title,
      createdAt: r.created_at,
    }));
  }

  private groupByExactContent(
    memories: DedupMemoryRef[],
    clusteredIds: Set<number>,
  ): DedupCluster[] {
    const clusters: DedupCluster[] = [];
    const groups = new Map<string, DedupMemoryRef[]>();

    for (const m of memories) {
      if (clusteredIds.has(m.id)) continue;
      const key = m.content.trim().toLowerCase();
      const group = groups.get(key) ?? [];
      group.push(m);
      groups.set(key, group);
    }

    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const ids = group.map(m => m.id);
      for (const id of ids) clusteredIds.add(id);
      clusters.push({
        representative: group[0],
        duplicateIds: ids.slice(1),
        clusterSize: group.length,
        averageSimilarity: 1,
        detectionMethod: 'exact_content',
      });
    }

    return clusters;
  }

  private groupByExactTitle(
    memories: DedupMemoryRef[],
    clusteredIds: Set<number>,
  ): DedupCluster[] {
    const clusters: DedupCluster[] = [];
    const groups = new Map<string, DedupMemoryRef[]>();

    for (const m of memories) {
      if (clusteredIds.has(m.id)) continue;
      if (!m.title) continue;
      const key = m.title.trim().toLowerCase();
      const group = groups.get(key) ?? [];
      group.push(m);
      groups.set(key, group);
    }

    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const ids = group.map(m => m.id);
      for (const id of ids) clusteredIds.add(id);
      clusters.push({
        representative: group[0],
        duplicateIds: ids.slice(1),
        clusterSize: group.length,
        averageSimilarity: 1,
        detectionMethod: 'exact_title',
      });
    }

    return clusters;
  }

  private async groupByEmbeddingSimilarity(
    memories: DedupMemoryRef[],
    threshold: number,
    clusteredIds: Set<number>,
  ): Promise<DedupCluster[]> {
    const clusters: DedupCluster[] = [];
    const processedIds = new Set<number>();
    const includeDifferentTypes = this.config.includeDifferentTypes ?? false;

    for (const mem of memories) {
      if (processedIds.has(mem.id)) continue;

      const neighborRows = await this.findNeighbors(mem.id, mem.memoryType, threshold, includeDifferentTypes);

      const validIds = [mem.id];
      for (const n of neighborRows) {
        if (!processedIds.has(n.id) && !clusteredIds.has(n.id)) {
          validIds.push(n.id);
        }
      }

      if (validIds.length < 2) {
        processedIds.add(mem.id);
        continue;
      }

      for (const id of validIds) {
        processedIds.add(id);
        clusteredIds.add(id);
      }

      const neighborSims = neighborRows
        .filter(n => validIds.includes(n.id))
        .map(n => n.similarity);
      const avgSim = neighborSims.length > 0
        ? neighborSims.reduce((a, b) => a + b, 0) / neighborSims.length
        : threshold;

      const clusterMems = memories.filter(m => validIds.includes(m.id));
      const rep = [...clusterMems].sort((a, b) => a.id - b.id)[0];

      clusters.push({
        representative: rep,
        duplicateIds: validIds.filter(id => id !== rep.id),
        clusterSize: validIds.length,
        averageSimilarity: avgSim,
        detectionMethod: 'embedding_similarity',
      });
    }

    return clusters;
  }

  private async findNeighbors(
    memoryId: number,
    memoryType: string,
    threshold: number,
    includeDifferentTypes: boolean,
  ): Promise<Array<{ id: number; similarity: number }>> {
    const params: unknown[] = [memoryId, threshold];
    let paramIdx = 2;
    let typeClause = '';

    if (!includeDifferentTypes) {
      paramIdx++;
      typeClause = ` AND m.memory_type = $${paramIdx}`;
      params.push(memoryType);
    }

    paramIdx++;
    const topK = 10;

    const sql = `
      SELECT mc.memory_id AS id, 1 - (mc.embedding <=> source.embedding) AS similarity
      FROM memory_chunks mc
      CROSS JOIN (SELECT embedding FROM memory_chunks WHERE memory_id = $1 LIMIT 1) source
      JOIN memories m ON m.id = mc.memory_id
      WHERE mc.memory_id != $1
        AND 1 - (mc.embedding <=> source.embedding) >= $2
        ${typeClause}
      ORDER BY mc.embedding <=> source.embedding
      LIMIT $${paramIdx}
    `;
    params.push(topK);

    const result = await this.pool.query(sql, params);
    return (result.rows as Array<{ id: number; similarity: number }>);
  }
}

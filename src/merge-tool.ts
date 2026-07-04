import type { Database } from './database.js';
import { getLogger } from './logger.js';
import { nowFn, dialectFromPool, colInParamArray, colNotInParamArray, jsonParam } from './db/query-dialect.js';

export interface MergeConfig {
  dryRun?: boolean;
  memoryTypes?: string[];
  excludeTypes?: string[];
  projectId?: string;
  maxGroups?: number;
}

export interface MergeGroup {
  canonicalId: number;
  duplicateIds: number[];
  normalizedHash: string;
  memoryType: string;
  content: string;
  canonicalCreatedAt: string;
  duplicateCount: number;
}

export interface MergeReport {
  dryRun: boolean;
  groups: MergeGroup[];
  totalCanonical: number;
  totalDuplicates: number;
  typesProcessed: string[];
  excludedTypes: string[];
  activeBefore: number;
  activeAfter: number;
}

const DEFAULT_EXCLUDE_TYPES = ['lesson'];

export class MemoryMerger {
  private pool: ReturnType<Database['getPool']>;

  constructor(database: Database) {
    this.pool = database.getPool();
  }

  async merge(config?: MergeConfig): Promise<MergeReport> {
    const logger = getLogger();
    const dryRun = config?.dryRun ?? false;
    const excludeTypes = config?.excludeTypes ?? DEFAULT_EXCLUDE_TYPES;

    const activeBefore = await this.countActive(config);
    logger.info(
      `MemoryMerge: ${dryRun ? 'dry-run' : 'apply'}, ` +
      `excludeTypes=[${excludeTypes.join(',')}], activeBefore=${activeBefore}`,
    );

    const groups = await this.findDuplicateGroups(config);
    logger.info(`MemoryMerge: found ${groups.length} merge groups`);

    if (groups.length === 0) {
      return {
        dryRun,
        groups: [],
        totalCanonical: 0,
        totalDuplicates: 0,
        typesProcessed: config?.memoryTypes ?? [],
        excludedTypes: excludeTypes,
        activeBefore,
        activeAfter: activeBefore,
      };
    }

    if (!dryRun) {
      await this.applyGroups(groups);
      logger.info(
        `MemoryMerge: applied ${groups.length} groups, ` +
        `${groups.reduce((s, g) => s + g.duplicateCount, 0)} duplicates marked superseded`,
      );
    }

    const activeAfter = !dryRun ? await this.countActive(config) : activeBefore;

    return {
      dryRun,
      groups,
      totalCanonical: groups.length,
      totalDuplicates: groups.reduce((s, g) => s + g.duplicateIds.length, 0),
      typesProcessed: config?.memoryTypes ?? [],
      excludedTypes: excludeTypes,
      activeBefore,
      activeAfter,
    };
  }

  private async countActive(config?: MergeConfig): Promise<number> {
    const d = dialectFromPool(this.pool);
    let sql = 'SELECT COUNT(*)::int AS cnt FROM memories WHERE superseded_by IS NULL';
    const params: unknown[] = [];
    if (config?.memoryTypes && config.memoryTypes.length > 0) {
      sql += ` AND ${colInParamArray(d, 'memory_type', 1)}`;
      params.push(jsonParam(d, config.memoryTypes));
    }
    if (config?.projectId) {
      const idx = params.length + 1;
      sql += ` AND project_id = $${idx}`;
      params.push(config.projectId);
    }
    const result = await this.pool.query(sql, params.length > 0 ? params : undefined);
    return (result.rows[0] as { cnt: number }).cnt;
  }

  private async findDuplicateGroups(config?: MergeConfig): Promise<MergeGroup[]> {
    const excludeTypes = config?.excludeTypes ?? DEFAULT_EXCLUDE_TYPES;
    const maxGroups = config?.maxGroups ?? 0;
    const memoryTypes = config?.memoryTypes;
    const projectId = config?.projectId;

    const d = dialectFromPool(this.pool);
    const conditions: string[] = ['m.superseded_by IS NULL'];
    const params: unknown[] = [];
    let paramIdx = 0;

    if (excludeTypes.length > 0) {
      paramIdx++;
      conditions.push(colNotInParamArray(d, 'm.memory_type', paramIdx));
      params.push(jsonParam(d, excludeTypes));
    }

    if (memoryTypes && memoryTypes.length > 0) {
      paramIdx++;
      conditions.push(colInParamArray(d, 'm.memory_type', paramIdx));
      params.push(jsonParam(d, memoryTypes));
    }

    if (projectId) {
      paramIdx++;
      conditions.push(`m.project_id = $${paramIdx}`);
      params.push(projectId);
    }

    const whereClause = conditions.join(' AND ');
    const limitClause = maxGroups > 0 ? ` LIMIT ${maxGroups}` : '';

    const sql = `
      SELECT
        LOWER(TRIM(m.content)) AS hash_key,
        MIN(m.id) AS canonical_id,
        array_agg(m.id ORDER BY m.id) AS all_ids,
        COUNT(*)::int AS cnt,
        m.memory_type,
        (SELECT content FROM memories WHERE id = MIN(m.id)) AS first_content,
        (SELECT created_at FROM memories WHERE id = MIN(m.id)) AS first_created_at
      FROM memories m
      WHERE ${whereClause}
      GROUP BY LOWER(TRIM(m.content)), m.memory_type
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
      ${limitClause}
    `;

    const result = await this.pool.query(sql, params);
    return (result.rows as Array<{
      hash_key: string;
      canonical_id: number;
      all_ids: number[];
      cnt: number;
      memory_type: string;
      first_content: string;
      first_created_at: string;
    }>).map(r => ({
      canonicalId: r.canonical_id,
      duplicateIds: r.all_ids.filter(id => id !== r.canonical_id),
      normalizedHash: r.hash_key,
      memoryType: r.memory_type,
      content: r.first_content,
      canonicalCreatedAt: r.first_created_at,
      duplicateCount: r.cnt,
    }));
  }

  private async applyGroups(groups: MergeGroup[]): Promise<void> {
    for (const group of groups) {
      await this.applyGroup(group);
    }
  }

  private async applyGroup(group: MergeGroup): Promise<void> {
    const duplicateIds = group.duplicateIds;

    await this.pool.query(
      `UPDATE memories
       SET superseded_by = $1, superseded_at = ${nowFn(dialectFromPool(this.pool))}
       WHERE ${colInParamArray(dialectFromPool(this.pool), 'id', 2)}
         AND superseded_by IS NULL
         AND id != $1`,
      [group.canonicalId, jsonParam(dialectFromPool(this.pool), duplicateIds)],
    );

    await this.pool.query(
      `INSERT INTO memory_merges
       (canonical_id, duplicate_ids, reason, normalized_hash, duplicate_count, merged_by)
       VALUES ($1, $2, 'exact_content', $3, $4, 'merge-tool')`,
      [group.canonicalId, JSON.stringify(duplicateIds), group.normalizedHash, group.duplicateCount],
    );
  }
}

import type { Database } from './database.js';
import { dialectFromPool, ageDaysExpr, jsonParam, isUniqueViolation } from './db/query-dialect.js';
import type { QueryDialect } from './db/query-dialect.js';

export type CandidateType =
  | 'prune'
  | 'promote_to_lesson'
  | 'merge'
  | 'stale_preference'
  | 'refresh_summary';

export type CandidateStatus = 'pending' | 'reviewed' | 'dismissed' | 'applied';

export const ALL_CANDIDATE_TYPES: CandidateType[] = [
  'prune',
  'promote_to_lesson',
  'merge',
  'stale_preference',
  'refresh_summary',
];

export interface CandidateRow {
  candidateType: CandidateType;
  memoryId: number;
  reason: string;
  confidence: number;
  sourceSignals: Record<string, unknown>;
}

export interface CandidateGeneratorConfig {
  dryRun?: boolean;
  types?: CandidateType[];
  maxPerType?: number;
  minAgeDaysPrune?: number;
  maxQualityScorePrune?: number;
  minRecallPromote?: number;
  minAgeDaysStalePreference?: number;
  minChunksRefresh?: number;
  projectId?: string;
}

export interface CandidateReport {
  dryRun: boolean;
  candidates: CandidateRow[];
  inserted: number;
  skippedDuplicates: number;
  byType: Record<string, number>;
}

interface RawRow {
  id: number;
  score: number | string;
  access_count: number | string;
  recall_count: number | string;
  memory_type: string;
  content: string;
  canonical_id: number | string | null;
  chunk_count: number | string;
}

function toNum(v: unknown): number {
  return typeof v === 'number' ? v : Number(v) || 0;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export class CandidateGenerator {
  private readonly pool: ReturnType<Database['getPool']>;

  constructor(private readonly database: Database) {
    this.pool = database.getPool();
  }

  async generate(config: CandidateGeneratorConfig = {}): Promise<CandidateReport> {
    const d = dialectFromPool(this.pool);
    const dryRun = config.dryRun ?? true;
    const types = config.types ?? ALL_CANDIDATE_TYPES;
    const maxPerType = config.maxPerType ?? 100;

    const candidates: CandidateRow[] = [];

    if (types.includes('prune')) {
      candidates.push(...await this.findPruneCandidates(d, config, maxPerType));
      candidates.push(...await this.findBreadcrumbLessonCandidates(d, config, maxPerType));
    }
    if (types.includes('promote_to_lesson')) {
      candidates.push(...await this.findPromoteCandidates(d, config, maxPerType));
    }
    if (types.includes('merge')) {
      candidates.push(...await this.findMergeCandidates(d, config, maxPerType));
    }
    if (types.includes('stale_preference')) {
      candidates.push(...await this.findStalePreferenceCandidates(d, config, maxPerType));
    }
    if (types.includes('refresh_summary')) {
      candidates.push(...await this.findRefreshSummaryCandidates(d, config, maxPerType));
    }

    const byType: Record<string, number> = {};
    for (const c of candidates) {
      byType[c.candidateType] = (byType[c.candidateType] ?? 0) + 1;
    }

    let inserted = 0;
    let skippedDuplicates = 0;

    if (!dryRun) {
      for (const c of candidates) {
        const ok = await this.insertCandidate(c, d);
        if (ok) inserted++;
        else skippedDuplicates++;
      }
    }

    return { dryRun, candidates, inserted, skippedDuplicates, byType };
  }

  async report(projectId?: string): Promise<{ byType: Record<string, number>; byStatus: Record<string, number>; total: number }> {
    const result = await this.pool.query(
      `SELECT queue.candidate_type, queue.status, COUNT(*) AS count
       FROM memory_candidate_queue queue
       JOIN memories memory_scope ON memory_scope.id = queue.memory_id
       WHERE ($1::text IS NULL OR memory_scope.project_id = $1)
       GROUP BY candidate_type, status
       ORDER BY candidate_type, status`,
      [projectId ?? null],
    );
    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of result.rows as Array<{ candidate_type: string; status: string; count: number | string }>) {
      const n = toNum(row.count);
      total += n;
      byType[row.candidate_type] = (byType[row.candidate_type] ?? 0) + n;
      byStatus[row.status] = (byStatus[row.status] ?? 0) + n;
    }
    return { byType, byStatus, total };
  }

  private async insertCandidate(c: CandidateRow, d: QueryDialect): Promise<boolean> {
    try {
      await this.pool.query(
        `INSERT INTO memory_candidate_queue
           (candidate_type, memory_id, reason, confidence, source_signals, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')`,
        [
          c.candidateType,
          c.memoryId,
          c.reason,
          c.confidence,
          jsonParam(d, c.sourceSignals),
        ],
      );
      return true;
    } catch (error) {
      if (isUniqueViolation(d, error)) return false;
      throw error;
    }
  }

  private async findPruneCandidates(
    d: QueryDialect,
    config: CandidateGeneratorConfig,
    maxPerType: number,
  ): Promise<CandidateRow[]> {
    const maxScore = config.maxQualityScorePrune ?? 0.5;
    const minAgeDays = config.minAgeDaysPrune ?? 30;
    const params: unknown[] = [maxScore, minAgeDays];
    let projectClause = '';
    if (config.projectId) {
      params.push(config.projectId);
      projectClause = ` AND m.project_id = $${params.length}`;
    }
    params.push(maxPerType);

    const sql = `
      SELECT m.id, mq.score, m.access_count,
             COALESCE(r.recall_count, 0) AS recall_count,
             m.memory_type, m.content, NULL::bigint AS canonical_id, 0 AS chunk_count
      FROM memories m
      JOIN memory_quality_scores mq ON mq.memory_id = m.id
      LEFT JOIN (
        SELECT memory_id, COUNT(*) AS recall_count
        FROM memory_recall_events
        GROUP BY memory_id
      ) r ON r.memory_id = m.id
      WHERE m.superseded_by IS NULL
        AND m.archived_at IS NULL
        AND mq.score < $1
        AND COALESCE(r.recall_count, 0) = 0
        AND ${ageDaysExpr(d, 'm.created_at')} > $2
        ${projectClause}
      ORDER BY mq.score ASC
      LIMIT $${params.length}
    `;

    const result = await this.pool.query(sql, params);
    return (result.rows as RawRow[]).map(r => ({
      candidateType: 'prune' as const,
      memoryId: r.id,
      reason: `Low quality (score=${toNum(r.score).toFixed(3)}), never recalled, age >${minAgeDays} days`,
      confidence: clamp01(0.5 + (maxScore - toNum(r.score))),
      sourceSignals: {
        qualityScore: toNum(r.score),
        accessCount: toNum(r.access_count),
        recallCount: toNum(r.recall_count),
        minAgeDays,
      },
    }));
  }

  private async findBreadcrumbLessonCandidates(
    _d: QueryDialect,
    config: CandidateGeneratorConfig,
    maxPerType: number,
  ): Promise<CandidateRow[]> {
    const params: unknown[] = [];
    let projectClause = '';
    if (config.projectId) {
      params.push(config.projectId);
      projectClause = ` AND m.project_id = $${params.length}`;
    }
    params.push(maxPerType);

    const sql = `
      SELECT m.id, m.content, m.access_count,
             COALESCE(r.recall_count, 0) AS recall_count
      FROM memories m
      LEFT JOIN (
        SELECT memory_id, COUNT(*) AS recall_count
        FROM memory_recall_events
        GROUP BY memory_id
      ) r ON r.memory_id = m.id
      WHERE m.superseded_by IS NULL
        AND m.archived_at IS NULL
        AND m.memory_type = 'lesson'
        AND m.emotion = 'frustration'
        AND m.content LIKE 'Instead of that approach, Fixed %'
        AND COALESCE(r.recall_count, 0) = 0
        ${projectClause}
      ORDER BY m.created_at DESC
      LIMIT $${params.length}
    `;

    const result = await this.pool.query(sql, params);
    return (result.rows as Array<{ id: number; content: string; access_count: number | string; recall_count: number | string }>).map((r) => ({
      candidateType: 'prune' as const,
      memoryId: r.id,
      reason: 'Low-signal frustration breadcrumb (auto-generated "Instead of that approach, Fixed ..." lesson, never recalled)',
      confidence: 0.8,
      sourceSignals: {
        memoryType: 'lesson',
        emotion: 'frustration',
        contentPattern: 'Instead of that approach, Fixed %',
        recallCount: toNum(r.recall_count),
        accessCount: toNum(r.access_count),
      },
    }));
  }

  private async findPromoteCandidates(
    d: QueryDialect,
    config: CandidateGeneratorConfig,
    maxPerType: number,
  ): Promise<CandidateRow[]> {
    const minRecall = config.minRecallPromote ?? 5;
    const params: unknown[] = [minRecall];
    let projectClause = '';
    if (config.projectId) {
      params.push(config.projectId);
      projectClause = ` AND m.project_id = $${params.length}`;
    }
    params.push(maxPerType);

    const sql = `
      SELECT m.id, m.memory_type, m.content, m.access_count,
             COALESCE(r.recall_count, 0) AS recall_count,
             0::numeric AS score, NULL::bigint AS canonical_id, 0 AS chunk_count
      FROM memories m
      LEFT JOIN (
        SELECT memory_id, COUNT(*) AS recall_count
        FROM memory_recall_events
        GROUP BY memory_id
      ) r ON r.memory_id = m.id
      WHERE m.superseded_by IS NULL
        AND m.archived_at IS NULL
        AND m.memory_type IN ('procedural', 'episodic')
        AND COALESCE(r.recall_count, 0) >= $1
        ${projectClause}
      ORDER BY r.recall_count DESC NULLS LAST
      LIMIT $${params.length}
    `;
    void d;

    const result = await this.pool.query(sql, params);
    return (result.rows as RawRow[]).map(r => {
      const recall = toNum(r.recall_count);
      return {
        candidateType: 'promote_to_lesson' as const,
        memoryId: r.id,
        reason: `Frequently recalled (${recall}x) ${r.memory_type} — candidate for lesson promotion`,
        confidence: clamp01(0.5 + Math.min(recall / 20, 0.4)),
        sourceSignals: {
          recallCount: recall,
          memoryType: r.memory_type,
          accessCount: toNum(r.access_count),
        },
      };
    });
  }

  private async findMergeCandidates(
    _d: QueryDialect,
    config: CandidateGeneratorConfig,
    maxPerType: number,
  ): Promise<CandidateRow[]> {
    const params: unknown[] = [];
    let projectClause = '';
    let duplicateProjectClause = '';
    if (config.projectId) {
      params.push(config.projectId);
      projectClause = ` AND m.project_id = $${params.length}`;
      duplicateProjectClause = ` AND project_id = $${params.length}`;
    }
    params.push(maxPerType);

    const sql = `
      WITH dups AS (
        SELECT LOWER(TRIM(content)) AS norm, COUNT(*) AS cnt, MIN(id) AS canonical_id
        FROM memories
        WHERE superseded_by IS NULL AND archived_at IS NULL
          ${duplicateProjectClause}
        GROUP BY LOWER(TRIM(content))
        HAVING COUNT(*) > 1
      )
      SELECT m.id, m.memory_type, m.content, dups.canonical_id,
             1::numeric AS score, 0 AS access_count, 0 AS recall_count, 0 AS chunk_count
      FROM memories m
      JOIN dups ON LOWER(TRIM(m.content)) = dups.norm
      WHERE m.id != dups.canonical_id
        AND m.superseded_by IS NULL
        AND m.archived_at IS NULL
        ${projectClause}
      ORDER BY m.id
      LIMIT $${params.length}
    `;

    const result = await this.pool.query(sql, params);
    return (result.rows as RawRow[]).map(r => ({
      candidateType: 'merge' as const,
      memoryId: r.id,
      reason: `Exact content duplicate of canonical memory #${toNum(r.canonical_id)}`,
      confidence: 0.9,
      sourceSignals: {
        canonicalId: toNum(r.canonical_id),
        detectionMethod: 'exact_content',
        memoryType: r.memory_type,
      },
    }));
  }

  private async findStalePreferenceCandidates(
    d: QueryDialect,
    config: CandidateGeneratorConfig,
    maxPerType: number,
  ): Promise<CandidateRow[]> {
    const minAgeDays = config.minAgeDaysStalePreference ?? 60;
    const params: unknown[] = [minAgeDays];
    let projectClause = '';
    if (config.projectId) {
      params.push(config.projectId);
      projectClause = ` AND m.project_id = $${params.length}`;
    }
    params.push(maxPerType);

    const sql = `
      SELECT m.id, m.memory_type, m.content, m.access_count,
             0::numeric AS score, NULL::bigint AS canonical_id, 0 AS recall_count, 0 AS chunk_count
      FROM memories m
      WHERE m.superseded_by IS NULL
        AND m.archived_at IS NULL
        AND m.memory_type = 'preference'
        AND ${ageDaysExpr(d, 'm.created_at')} > $1
        ${projectClause}
      ORDER BY m.created_at ASC
      LIMIT $${params.length}
    `;

    const result = await this.pool.query(sql, params);
    return (result.rows as RawRow[]).map(r => ({
      candidateType: 'stale_preference' as const,
      memoryId: r.id,
      reason: `Old preference (age >${minAgeDays} days) — review against newer preferences`,
      confidence: 0.5,
      sourceSignals: {
        memoryType: 'preference',
        minAgeDays,
        accessCount: toNum(r.access_count),
      },
    }));
  }

  private async findRefreshSummaryCandidates(
    _d: QueryDialect,
    config: CandidateGeneratorConfig,
    maxPerType: number,
  ): Promise<CandidateRow[]> {
    const minChunks = config.minChunksRefresh ?? 3;
    const params: unknown[] = [minChunks];
    let projectClause = '';
    if (config.projectId) {
      params.push(config.projectId);
      projectClause = ` AND m.project_id = $${params.length}`;
    }
    params.push(maxPerType);

    const sql = `
      SELECT m.id, m.memory_type, m.content,
             COALESCE(c.chunk_count, 0) AS chunk_count,
             0::numeric AS score, NULL::bigint AS canonical_id, 0 AS access_count, 0 AS recall_count
      FROM memories m
      LEFT JOIN (
        SELECT memory_id, COUNT(*) AS chunk_count
        FROM memory_chunks
        GROUP BY memory_id
      ) c ON c.memory_id = m.id
      WHERE m.superseded_by IS NULL
        AND m.archived_at IS NULL
        AND m.memory_type = 'episodic'
        AND COALESCE(c.chunk_count, 0) >= $1
        ${projectClause}
      ORDER BY c.chunk_count DESC NULLS LAST
      LIMIT $${params.length}
    `;

    const result = await this.pool.query(sql, params);
    return (result.rows as RawRow[]).map(r => {
      const chunks = toNum(r.chunk_count);
      return {
        candidateType: 'refresh_summary' as const,
        memoryId: r.id,
        reason: `Episodic memory with ${chunks} chunks — candidate for summary refresh`,
        confidence: clamp01(0.5 + Math.min(chunks / 20, 0.3)),
        sourceSignals: {
          chunkCount: chunks,
          memoryType: 'episodic',
        },
      };
    });
  }
}

/**
 * Phase 6B: Recall Quality Audit Tool
 *
 * Read-only audit surface for measuring recall quality.
 * Report-first approach with human-readable text output.
 *
 * PG-specific SQL (FILTER, interval, ARRAY_AGG). SQLite degrades to "N/A".
 */

import type { DatabasePool } from './types.js';
import { dialectFromPool } from './db/query-dialect.js';

// ============================================================================
// Tool Interface
// ============================================================================

export interface RecallQualityAuditParams {
  scope?: 'project' | 'session' | 'file';
  projectId?: string;
  sessionId?: string;
  filePath?: string;
  since?: string;
  limit?: number;
}

export interface IRecallQualityTool {
  generateReport(
    pool: DatabasePool,
    params: RecallQualityAuditParams
  ): Promise<string>;
}

// ============================================================================
// Row DTOs (typed query results)
// ============================================================================

interface SurfaceCountRow { surface_count: number | string }
interface RateRow { rate: number | string | null }
interface SurfacesRow { surfaces: string[] | null }

// ============================================================================
// Validation
// ============================================================================

export function validateRecallQualityAuditParams(params: RecallQualityAuditParams): void {
  if (params.since) {
    const date = new Date(params.since);
    if (isNaN(date.getTime())) {
      throw new Error('since must be a valid ISO date string');
    }
  }

  if (params.limit !== undefined) {
    if (params.limit < 1 || params.limit > 10000) {
      throw new Error('limit must be between 1 and 10000');
    }
  }

  if (params.scope && params.scope !== 'project' && params.scope !== 'session' && params.scope !== 'file') {
    throw new Error('scope must be one of: project, session, file');
  }

  if (params.scope === 'project' && !params.projectId) {
    throw new Error('projectId is required when scope is project');
  }

  if (params.scope === 'session' && !params.sessionId) {
    throw new Error('sessionId is required when scope is session');
  }

  if (params.scope === 'file' && !params.filePath) {
    throw new Error('filePath is required when scope is file');
  }
}

// ============================================================================
// Report Builder
// ============================================================================

interface ReportSections {
  relevance: string;
  recallRate: string;
  freshness: string;
  stability: string;
  coverage: string;
  queryQuality: string;
}

interface AuditWindow {
  windowStart: string;
  windowEnd: string;
  limit: number;
  scope: string;
  scopeFilter: string;
  scopeParams: unknown[];
}

export class RecallQualityAuditReportBuilder {
  private pool: DatabasePool;

  constructor(pool: DatabasePool) {
    this.pool = pool;
  }

  async generateReport(params: RecallQualityAuditParams): Promise<string> {
    const dialect = dialectFromPool(this.pool);
    const windowStart = params.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const windowEnd = new Date().toISOString();
    const limit = params.limit || 1000;

    let scope: string;
    let scopeFilter = '';
    let scopeParams: unknown[] = [];
    if (params.scope === 'session') {
      scope = `session: ${params.sessionId || 'unknown'}`;
      scopeFilter = ' AND session_id = $SCOPE';
      scopeParams = [params.sessionId];
    } else if (params.scope === 'file') {
      scope = `file: ${params.filePath || 'unknown'}`;
      scopeFilter = ' AND project_id = $SCOPE';
      scopeParams = [params.filePath];
    } else {
      scope = `project: ${params.projectId || 'all'}`;
      if (params.projectId) {
        scopeFilter = ' AND project_id = $SCOPE';
        scopeParams = [params.projectId];
      }
    }

    const win: AuditWindow = { windowStart, windowEnd, limit, scope, scopeFilter, scopeParams };

    if (dialect === 'sqlite') {
      return this.degradedReport(win);
    }

    const surfacesObserved = await this.countSurfaces(win);
    const sections: ReportSections = {
      relevance: await this.buildRelevanceSection(win),
      recallRate: await this.buildRecallRateSection(win),
      freshness: await this.buildFreshnessSection(win),
      stability: await this.buildStabilitySection(win),
      coverage: await this.buildCoverageSection(win),
      queryQuality: await this.buildQueryQualitySection(win),
    };

    return this.formatReport(win, surfacesObserved, sections);
  }

  private buildQuery(win: AuditWindow, sqlBody: string, extraParams: unknown[] = []): { sql: string; params: unknown[] } {
    const params: unknown[] = [win.windowStart, win.windowEnd, ...extraParams, ...win.scopeParams, win.limit];
    let sql = sqlBody.replace(/\$1/g, '$' + (params.length - 2 - win.scopeParams.length));
    sql = sql.replace(/\$2/g, '$' + (params.length - 1 - win.scopeParams.length));
    let scopeIdx = params.length - 1 - win.scopeParams.length;
    for (let i = 0; i < win.scopeParams.length; i++) {
      scopeIdx++;
      sql = sql.replace(/\$SCOPE/g, '$' + scopeIdx);
    }
    sql = sql.replace(/\$LIMIT/g, '$' + params.length);
    return { sql, params };
  }

  private async countSurfaces(win: AuditWindow): Promise<number> {
    const { sql, params } = this.buildQuery(win, `
      SELECT COUNT(DISTINCT source) as surface_count
      FROM (
        SELECT source FROM memory_recall_events
        WHERE recalled_at >= $1 AND recalled_at < $2
          AND rank > 0${win.scopeFilter}
        LIMIT $LIMIT
      ) sub
    `);
    const result = await this.pool.query(sql, params);
    const row = result.rows[0] as SurfaceCountRow | undefined;
    return row ? Number(row.surface_count) : 0;
  }

  private async buildRelevanceSection(win: AuditWindow): Promise<string> {
    const { sql: top3Sql, params: top3Params } = this.buildQuery(win, `
      SELECT
        COUNT(*) FILTER (WHERE rank <= 3) * 100.0 / NULLIF(COUNT(*), 0) as rate,
        COUNT(*) FILTER (WHERE rank <= 3) as top3_count,
        COUNT(*) as total
      FROM (
        SELECT rank FROM memory_recall_events
        WHERE recalled_at >= $1 AND recalled_at < $2
          AND rank > 0${win.scopeFilter}
        LIMIT $LIMIT
      ) sub
    `);
    const { sql: mrrSql, params: mrrParams } = this.buildQuery(win, `
      SELECT AVG(1.0 / NULLIF(rank, 0)) as rate
      FROM (
        SELECT rank FROM memory_recall_events
        WHERE recalled_at >= $1 AND recalled_at < $2
          AND rank > 0${win.scopeFilter}
        LIMIT $LIMIT
      ) sub
    `);

    const top3Result = await this.pool.query(top3Sql, top3Params);
    const mrrResult = await this.pool.query(mrrSql, mrrParams);
    const top3Row = top3Result.rows[0] as (RateRow & { top3_count: number | string; total: number | string }) | undefined;
    const mrrRow = mrrResult.rows[0] as RateRow | undefined;

    const top3Rate = top3Row ? Number(top3Row.rate) || 0 : 0;
    const top3Count = top3Row ? Number(top3Row.top3_count) || 0 : 0;
    const total = top3Row ? Number(top3Row.total) || 0 : 0;
    const mrr = mrrRow ? Number(mrrRow.rate) || 0 : 0;

    return `Relevance
────────
Top-3 recall rate: ${top3Rate.toFixed(0)}% (${top3Count}/${total} recalled in top 3)
Mean Reciprocal Rank: ${mrr.toFixed(2)}`;
  }

  private async buildRecallRateSection(win: AuditWindow): Promise<string> {
    const { sql: emptySql, params: emptyParams } = this.buildQuery(win, `
      SELECT
        COUNT(DISTINCT query_hash) FILTER (
          WHERE query_hash NOT IN (
            SELECT query_hash FROM memory_recall_events
            WHERE recalled_at >= $1 AND recalled_at < $2${win.scopeFilter}
          )
        ) as empty_queries,
        COUNT(DISTINCT query_hash) as total_queries
      FROM (
        SELECT query_hash FROM memory_recall_events
        WHERE recalled_at >= $1 AND recalled_at < $2${win.scopeFilter}
        LIMIT $LIMIT
      ) sub
    `);
    const { sql: searchSql, params: searchParams } = this.buildQuery(win, `
      SELECT
        COUNT(DISTINCT query_hash) FILTER (WHERE source = 'search') as search_queries,
        COUNT(DISTINCT query_hash) as total_queries
      FROM (
        SELECT query_hash, source FROM memory_recall_events
        WHERE recalled_at >= $1 AND recalled_at < $2${win.scopeFilter}
        LIMIT $LIMIT
      ) sub
    `);

    const emptyResult = await this.pool.query(emptySql, emptyParams);
    const searchResult = await this.pool.query(searchSql, searchParams);
    const emptyActual = emptyResult.rows[0] as { empty_queries: number | string; total_queries: number | string } | undefined;
    const emptyCount = emptyActual ? Number(emptyActual.empty_queries) || 0 : 0;
    const totalQueries = emptyActual ? Number(emptyActual.total_queries) || 0 : 0;
    const searchActual = searchResult.rows[0] as { search_queries: number | string; total_queries: number | string } | undefined;
    const searchCount = searchActual ? Number(searchActual.search_queries) || 0 : 0;
    const searchTotal = searchActual ? Number(searchActual.total_queries) || 0 : 0;
    const emptyRate = totalQueries > 0 ? (emptyCount / totalQueries) * 100 : 0;
    const searchRate = searchTotal > 0 ? (searchCount / searchTotal) * 100 : 0;

    return `Recall Rate
───────────
Empty result rate: ${emptyRate.toFixed(0)}% (${emptyCount}/${totalQueries} queries with 0 results)
Search recall rate: ${searchRate.toFixed(0)}% (${searchCount}/${searchTotal} queries returned results)`;
  }

  private async buildFreshnessSection(win: AuditWindow): Promise<string> {
    const { sql: freshSql, params: freshParams } = this.buildQuery(win, `
      SELECT
        COUNT(*) FILTER (
          WHERE m.created_at >= $1::timestamptz - interval '7 days'
        ) * 100.0 / NULLIF(COUNT(*), 0) as rate
      FROM (
        SELECT memory_id FROM memory_recall_events
        WHERE recalled_at >= $1 AND recalled_at < $2${win.scopeFilter}
        LIMIT $LIMIT
      ) sub
      JOIN memories m ON m.id = sub.memory_id
    `);
    const { sql: staleSql, params: staleParams } = this.buildQuery(win, `
      SELECT
        COUNT(*) FILTER (
          WHERE m.created_at < $1::timestamptz - interval '30 days'
        ) * 100.0 / NULLIF(COUNT(*), 0) as rate
      FROM (
        SELECT memory_id FROM memory_recall_events
        WHERE recalled_at >= $1 AND recalled_at < $2${win.scopeFilter}
        LIMIT $LIMIT
      ) sub
      JOIN memories m ON m.id = sub.memory_id
    `);

    const freshResult = await this.pool.query(freshSql, freshParams);
    const staleResult = await this.pool.query(staleSql, staleParams);
    const freshRow = freshResult.rows[0] as RateRow | undefined;
    const staleRow = staleResult.rows[0] as RateRow | undefined;

    const freshRate = freshRow ? Number(freshRow.rate) || 0 : 0;
    const staleRate = staleRow ? Number(staleRow.rate) || 0 : 0;

    return `Freshness
─────────
Fresh recall rate (7d): ${freshRate.toFixed(0)}% (recalled memories created < 7 days before window start)
Stale recall rate (>30d): ${staleRate.toFixed(0)}% (recalled memories created > 30 days before window start)`;
  }

  private async buildStabilitySection(win: AuditWindow): Promise<string> {
    const { sql, params } = this.buildQuery(win, `
      SELECT
        COUNT(*) FILTER (
          WHERE memory_id IN (
            SELECT memory_id FROM (
              SELECT memory_id FROM memory_recall_events
              WHERE recalled_at >= $1 AND recalled_at < $2${win.scopeFilter}
              LIMIT $LIMIT
            ) dup_sub
            GROUP BY memory_id
            HAVING COUNT(*) > 1
          )
        ) * 100.0 / NULLIF(COUNT(*), 0) as rate
      FROM (
        SELECT memory_id FROM memory_recall_events
        WHERE recalled_at >= $1 AND recalled_at < $2${win.scopeFilter}
        LIMIT $LIMIT
      ) sub
    `);

    const result = await this.pool.query(sql, params);
    const row = result.rows[0] as RateRow | undefined;
    const duplicateRate = row ? Number(row.rate) || 0 : 0;

    return `Stability
─────────
Duplicate recall events: ${duplicateRate.toFixed(0)}% (memories recalled >1 time in window)
Oscillating recall: N/A (not implemented in 6B)`;
  }

  private async buildCoverageSection(win: AuditWindow): Promise<string> {
    const { sql, params } = this.buildQuery(win, `
      SELECT ARRAY_AGG(DISTINCT source ORDER BY source) as surfaces
      FROM (
        SELECT source FROM memory_recall_events
        WHERE recalled_at >= $1 AND recalled_at < $2${win.scopeFilter}
        LIMIT $LIMIT
      ) sub
    `);

    const result = await this.pool.query(sql, params);
    const row = result.rows[0] as SurfacesRow | undefined;
    const surfaces = row?.surfaces || [];
    const expectedSurfaces = ['search', 'list', 'context_recall', 'graph', 'vector_only', 'text_only', 'text_fallback', 'empty_result'];
    const missingSurfaces = expectedSurfaces.filter(s => !surfaces.includes(s));

    return `Coverage
────────
Surfaces fired: ${surfaces.join(', ') || 'none'}
Missing surfaces: ${missingSurfaces.length > 0 ? missingSurfaces.join(', ') : 'none'}`;
  }

  private async buildQueryQualitySection(win: AuditWindow): Promise<string> {
    const { sql: fallbackSql, params: fallbackParams } = this.buildQuery(win, `
      SELECT
        COUNT(*) FILTER (WHERE source = 'search') * 100.0 / NULLIF(COUNT(*), 0) as rate
      FROM (
        SELECT source FROM memory_recall_events
        WHERE recalled_at >= $1 AND recalled_at < $2${win.scopeFilter}
        LIMIT $LIMIT
      ) sub
    `);
    const { sql: vectorSql, params: vectorParams } = this.buildQuery(win, `
      SELECT
        COUNT(*) FILTER (WHERE m.embedding IS NOT NULL) * 100.0 / NULLIF(COUNT(*), 0) as rate
      FROM (
        SELECT memory_id FROM memory_recall_events
        WHERE recalled_at >= $1 AND recalled_at < $2${win.scopeFilter}
        LIMIT $LIMIT
      ) sub
      JOIN memories m ON m.id = sub.memory_id
    `);
    const { sql: lowResultSql, params: lowResultParams } = this.buildQuery(win, `
      SELECT
        COUNT(*) FILTER (WHERE per_query.cnt < 3) * 100.0 / NULLIF(COUNT(*), 0) as rate
      FROM (
        SELECT query_hash, COUNT(*) as cnt
        FROM memory_recall_events
        WHERE recalled_at >= $1 AND recalled_at < $2${win.scopeFilter}
        GROUP BY query_hash
        LIMIT $LIMIT
      ) per_query
    `);

    const fallbackResult = await this.pool.query(fallbackSql, fallbackParams);
    const vectorResult = await this.pool.query(vectorSql, vectorParams);
    const lowResultResult = await this.pool.query(lowResultSql, lowResultParams);
    const fallbackRow = fallbackResult.rows[0] as RateRow | undefined;
    const vectorRow = vectorResult.rows[0] as RateRow | undefined;
    const lowResultRow = lowResultResult.rows[0] as RateRow | undefined;

    const fallbackRate = fallbackRow ? Number(fallbackRow.rate) || 0 : 0;
    const vectorHealth = vectorRow ? Number(vectorRow.rate) || 0 : 0;
    const lowResultRate = lowResultRow ? Number(lowResultRow.rate) || 0 : 0;

    return `Query Quality
─────────────
Text fallback rate: ${fallbackRate.toFixed(0)}% (search-source recall events)
Vector health: ${vectorHealth.toFixed(0)}% (recalled memories with embeddings)
Low-result searches (<3 results): ${lowResultRate.toFixed(0)}%`;
  }

  private degradedReport(win: AuditWindow): string {
    return `Recall Quality Report
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Window: ${win.windowStart} → ${win.windowEnd}
Scope:  ${win.scope}
Surfaces observed: N/A
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Note: Recall quality audit requires PostgreSQL (FILTER, interval, ARRAY_AGG).
SQLite support is planned for Phase 6C+.`;
  }

  private formatReport(win: AuditWindow, surfacesObserved: number, sections: ReportSections): string {
    const lines = [
      'Recall Quality Report',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `Window: ${win.windowStart} → ${win.windowEnd}`,
      `Scope:  ${win.scope}`,
      `Surfaces observed: ${surfacesObserved}/8`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      sections.relevance,
      '',
      sections.recallRate,
      '',
      sections.freshness,
      '',
      sections.stability,
      '',
      sections.coverage,
      '',
      sections.queryQuality,
      '',
      'Note: This is Phase 6B (report-only, no scoring). Full metrics and scores in 6C/6D.',
    ];

    return lines.join('\n');
  }
}

// ============================================================================
// Mock Data (for testing only)
// ============================================================================

export function mockRecallQualityAuditReport(params: RecallQualityAuditParams): string {
  return `Recall Quality Report
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Window: ${params.since || 'last 24h'}
Scope:  project: ${params.projectId || 'unknown'}
Surfaces observed: 4/8
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Relevance
────────
Top-3 recall rate: 42% (8/19 recalled in top 3)
Mean Reciprocal Rank: 0.32

Recall Rate
───────────
Empty result rate: 8% (1/12 queries with 0 results)
Search recall rate: 92% (11/12 queries returned results)

Freshness
─────────
Fresh recall rate (7d): 35% (7/20 recalled memories < 7 days old)
Stale recall rate (>30d): 15% (3/20 recalled memories > 30 days old)

Stability
─────────
Duplicate recall events: 12% (4 of 34 recalls occurred >1 time)
Oscillating recall: N/A (not implemented in 6B)

Coverage
────────
Surfaces fired: search, list, context_recall
Missing surfaces: graph, vector_only, text_only, text_fallback (implementation in 6C)

Query Quality
─────────────
Text fallback rate: 5% (some/all recall events)
Vector health: 85% (recalled memories have embeddings)
Low-result searches (<3 results): N/A (not implemented in 6B)

Note: This is Phase 6B (report-only, no scoring). Full metrics and scores in 6C/6D.`;
}

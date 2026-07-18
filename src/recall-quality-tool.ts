/**
 * Phase 6B: Recall Quality Audit Tool
 * Phase 6D: Advisory scoring + recommendations layer
 *
 * Read-only audit surface for measuring recall quality.
 * Report-first approach with human-readable text output.
 *
 * PG-specific SQL (FILTER, interval, ARRAY_AGG). SQLite degrades to advisory "sparse_data".
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
interface SurfacesRow { sources: string[] | null }
interface SourceDistRow { source: string; count: number | string }
interface NullRateRow { null_count: number | string; total: number | string }

// ============================================================================
// Advisory Scoring (Phase 6D)
// ============================================================================

export type RecallQualityGrade = 'healthy' | 'sparse_data' | 'needs_attention' | 'degraded' | 'unknown';

export interface RecallQualityScore {
  grade: RecallQualityGrade;
  confidence: number; // 0-1 — how confident we are in the score (low traffic → low confidence)
  reasons: string[];   // why this grade was chosen
  recommendations: string[]; // advisory suggestions, never imperative
}

/**
 * Raw metrics collected during report generation.
 * Passed to scoreMetrics() to produce an advisory score.
 */
export interface RecallMetrics {
  totalEvents: number;
  surfacesFired: string[];
  surfacesMissing: string[];
  surfaceCount: number;
  top3Rate: number;
  mrr: number;
  emptyResultRate: number;
  searchRecallRate: number;
  freshRate: number;
  staleRate: number;
  duplicateRate: number;
  textFallbackRate: number;
  vectorHealthRate: number;
  lowResultRate: number;
  sourceDistribution: Record<string, number>;
  nullMemoryIdRate: number;
  graphEventCount: number;
  dialect: string;
}

// Thresholds — conservative; err toward "sparse_data" rather than "degraded" on low traffic
const MIN_EVENTS_FOR_CONFIDENCE = 50;      // <50 events → low confidence
const MIN_EVENTS_FOR_SCORING = 10;         // <10 events → sparse_data
const EMPTY_RESULT_WARN_PCT = 50;           // >50% empty → needs_attention
const FALLBACK_WARN_PCT = 40;               // >40% text fallback → needs_attention
const VECTOR_HEALTH_WARN_PCT = 50;          // <50% embeddings → needs_attention
const DUPLICATE_HIGH_PCT = 60;              // >60% duplicates → needs_attention

export function scoreMetrics(m: RecallMetrics): RecallQualityScore {
  const reasons: string[] = [];
  const recommendations: string[] = [];

  // 1. No data at all
  if (m.totalEvents === 0) {
    return {
      grade: 'unknown',
      confidence: 0,
      reasons: ['No recall events recorded in this window. No data to score.'],
      recommendations: [
        'No recall activity detected in the selected window. This is expected for new sessions or low-traffic periods.',
        'Try a wider window (e.g., since 7 days ago) to accumulate enough telemetry for scoring.',
      ],
    };
  }

  // 2. SQLite: text-only path — can't measure PG-specific metrics
  if (m.dialect === 'sqlite') {
    return {
      grade: 'sparse_data',
      confidence: 0,
      reasons: [
        'SQLite does not support the SQL features (FILTER, interval, ARRAY_AGG) needed for full recall quality scoring.',
        'Telemetry is still recorded, but audit scoring requires PostgreSQL.',
      ],
      recommendations: [
        'Switch to PostgreSQL to enable full recall quality scoring.',
        'SQLite recall events are valid and will be scored if migrated to PG.',
      ],
    };
  }

  // 3. Sparse data — low traffic, don't flag as failure
  if (m.totalEvents < MIN_EVENTS_FOR_SCORING) {
    return {
      grade: 'sparse_data',
      confidence: 0.25,
      reasons: [
        `Only ${m.totalEvents} recall events in the window (min ${MIN_EVENTS_FOR_SCORING} for full scoring).`,
        `Only ${m.surfaceCount}/8 recall surfaces fired. This is expected for low-traffic windows.`,
      ],
      recommendations: [
        'Sparse data is not a quality problem. The audit needs more recall activity to produce a meaningful score.',
        'Try a wider window (e.g., since 7 days ago) or wait for more recall events to accumulate.',
      ],
    };
  }

  // 4. Low confidence but enough to score
  const lowConfidence = m.totalEvents < MIN_EVENTS_FOR_CONFIDENCE;
  const isDegraded = false;
  let needsAttention = false;

  // Surface coverage
  if (m.surfaceCount < 3) {
    reasons.push(`Only ${m.surfaceCount}/8 recall surfaces fired in this window.`);
    recommendations.push('Sparse surface coverage may be expected for low-traffic windows. More diverse recall activity (search, list, graph) will improve coverage.');
  }

  // Empty result rate
  if (m.emptyResultRate > EMPTY_RESULT_WARN_PCT) {
    needsAttention = true;
    reasons.push(`High empty-result rate (${m.emptyResultRate.toFixed(0)}%): many queries returned 0 results.`);
    recommendations.push('High empty-result rate may indicate query mismatch or missing memory coverage. Consider whether the memory store has relevant content for the queries being issued.');
  }

  // Text fallback rate
  if (m.textFallbackRate > FALLBACK_WARN_PCT) {
    needsAttention = true;
    reasons.push(`High text fallback rate (${m.textFallbackRate.toFixed(0)}%): vector search is being bypassed frequently.`);
    recommendations.push('High text fallback rate may indicate vector search degradation. Check embedding provider status (Ollama/OpenAI) and embedding dimensions.');
  }

  // Vector health
  if (m.vectorHealthRate < VECTOR_HEALTH_WARN_PCT && m.totalEvents > MIN_EVENTS_FOR_SCORING) {
    needsAttention = true;
    reasons.push(`Low vector health (${m.vectorHealthRate.toFixed(0)}%): many recalled memories lack embeddings.`);
    recommendations.push('Low embedding coverage may degrade vector search quality. Consider running csm_memory_backfill_embeddings to backfill missing embeddings.');
  }

  // Duplicate rate (high // MRR degradation)
  if (m.duplicateRate > DUPLICATE_HIGH_PCT) {
    needsAttention = true;
    reasons.push(`High duplicate recall rate (${m.duplicateRate.toFixed(0)}%): same memories recalled multiple times.`);
    recommendations.push('High duplicate recall may indicate oscillating recall behavior or insufficient deduplication in the recall pipeline.');
  }

  // Graph recall absent — advisory, not a failure
  if (m.graphEventCount === 0) {
    reasons.push('No graph recall events recorded.');
    recommendations.push('Graph recall unavailable or unused; this may be expected if few memories have links. Graph links are only created during memory storage with relationship extraction.');
  }

  // Determine grade
  let grade: RecallQualityGrade;
  if (isDegraded) {
    grade = 'degraded';
  } else if (needsAttention) {
    grade = 'needs_attention';
  } else {
    grade = 'healthy';
  }

  // Override to sparse_data if low confidence and not actively degraded
  if (lowConfidence && grade === 'healthy') {
    grade = 'sparse_data';
    reasons.push(`Low confidence: only ${m.totalEvents} events (min ${MIN_EVENTS_FOR_CONFIDENCE} for high confidence). Grade is provisional.`);
  }

  // If no specific issues found and enough data, it's healthy
  if (reasons.length === 0) {
    reasons.push(`${m.surfaceCount}/8 surfaces fired, ${m.totalEvents} events recorded, no abnormal patterns detected.`);
  }

  const confidence = lowConfidence ? 0.5 : Math.min(1, m.totalEvents / 200);

  return { grade, confidence, reasons, recommendations };
}

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

  async generateReport(params: RecallQualityAuditParams, includeScore = true): Promise<string> {
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
      const metrics: RecallMetrics = {
        totalEvents: 0, surfacesFired: [], surfacesMissing: [], surfaceCount: 0,
        top3Rate: 0, mrr: 0, emptyResultRate: 0, searchRecallRate: 0,
        freshRate: 0, staleRate: 0, duplicateRate: 0, textFallbackRate: 0,
        vectorHealthRate: 0, lowResultRate: 0, sourceDistribution: {}, nullMemoryIdRate: 0,
        graphEventCount: 0, dialect: 'sqlite',
      };
      return this.degradedReport(win, includeScore ? scoreMetrics(metrics) : undefined);
    }

    // Collect raw metrics in parallel with report sections
    const metricsPromise = this.collectMetrics(win, dialect);
    const sectionsPromise = this.collectSections(win);

    const [metrics, sections] = await Promise.all([metricsPromise, sectionsPromise]);
    const score = includeScore ? scoreMetrics(metrics) : undefined;
    return this.formatReport(win, metrics, sections, score);
  }

  private async collectMetrics(win: AuditWindow, dialect: string): Promise<RecallMetrics> {
    // Surface coverage + source distribution
    const { sql: surfSql, params: surfParams } = this.buildQuery(win, `
      SELECT source, COUNT(*) as count
      FROM (
        SELECT source FROM memory_recall_events
        WHERE recalled_at >= $1 AND recalled_at < $2${win.scopeFilter}
        LIMIT $LIMIT
      ) sub
      GROUP BY source ORDER BY count DESC
    `);
    const surfResult = await this.pool.query(surfSql, surfParams);
    const distRows = surfResult.rows as SourceDistRow[];
    const sourceDistribution: Record<string, number> = {};
    for (const r of distRows) {
      sourceDistribution[r.source] = Number(r.count) || 0;
    }
    const surfacesFired = distRows.map(r => r.source);
    const expectedSurfaces = ['search', 'list', 'context_recall', 'graph', 'vector_only', 'text_only', 'text_fallback', 'empty_result'];
    const surfacesMissing = expectedSurfaces.filter(s => !surfacesFired.includes(s));
    const totalEvents = Object.values(sourceDistribution).reduce((a, b) => a + b, 0);

    // Relevance — measured on search results only (context_recall is not a ranked search)
    const { sql: relSql, params: relParams } = this.buildQuery(win, `
      SELECT
        COUNT(*) FILTER (WHERE rank <= 3) * 100.0 / NULLIF(COUNT(*), 0) as top3,
        AVG(1.0 / NULLIF(rank, 0)) as mrr,
        COUNT(*) as total
      FROM (
        SELECT rank FROM memory_recall_events
        WHERE recalled_at >= $1 AND recalled_at < $2 AND rank > 0
          AND source IN ('search', 'vector_only', 'text_only', 'text_fallback')${win.scopeFilter}
        LIMIT $LIMIT
      ) sub
    `);
    const relResult = await this.pool.query(relSql, relParams);
    const relRow = relResult.rows[0] as { top3: number | string | null; mrr: number | string | null; total: number | string } | undefined;
    const top3Rate = relRow && relRow.top3 != null ? Number(relRow.top3) || 0 : 0;
    const mrr = relRow && relRow.mrr != null ? Number(relRow.mrr) || 0 : 0;

    // Recall rate (empty_result source count / total)
    const emptyCount = sourceDistribution['empty_result'] || 0;
    const emptyResultRate = totalEvents > 0 ? (emptyCount / totalEvents) * 100 : 0;
    const searchCount = sourceDistribution['search'] || 0;
    const searchRecallRate = totalEvents > 0 ? (searchCount / totalEvents) * 100 : 0;

    // Fallback rate (text_fallback + text_only / total)
    const textFallbackCount = (sourceDistribution['text_fallback'] || 0) + (sourceDistribution['text_only'] || 0);
    const textFallbackRate = totalEvents > 0 ? (textFallbackCount / totalEvents) * 100 : 0;

    // Vector health (memories with embeddings)
    const { sql: vecSql, params: vecParams } = this.buildQuery(win, `
      SELECT COUNT(*) FILTER (WHERE m.embedding IS NOT NULL) * 100.0 / NULLIF(COUNT(*), 0) as rate
      FROM (
        SELECT memory_id FROM memory_recall_events
        WHERE recalled_at >= $1 AND recalled_at < $2${win.scopeFilter} AND rank > 0
        LIMIT $LIMIT
      ) sub
      JOIN memories m ON m.id = sub.memory_id
    `);
    const vecResult = await this.pool.query(vecSql, vecParams);
    const vecRow = vecResult.rows[0] as RateRow | undefined;
    const vectorHealthRate = vecRow && vecRow.rate != null ? Number(vecRow.rate) || 0 : 0;

    // Low-result searches — search sources only
    const { sql: lowSql, params: lowParams } = this.buildQuery(win, `
      SELECT
        COUNT(*) FILTER (WHERE per_query.cnt < 3) * 100.0 / NULLIF(COUNT(*), 0) as rate
      FROM (
        SELECT query_hash, COUNT(*) as cnt
        FROM memory_recall_events
        WHERE recalled_at >= $1 AND recalled_at < $2
          AND source IN ('search', 'vector_only', 'text_only', 'text_fallback')${win.scopeFilter}
        GROUP BY query_hash
        LIMIT $LIMIT
      ) per_query
    `);
    const lowResult = await this.pool.query(lowSql, lowParams);
    const lowRow = lowResult.rows[0] as RateRow | undefined;
    const lowResultRate = lowRow && lowRow.rate != null ? Number(lowRow.rate) || 0 : 0;

    // Freshness
    const { sql: freshSql, params: freshParams } = this.buildQuery(win, `
      SELECT COUNT(*) FILTER (WHERE m.created_at >= $1::timestamptz - interval '7 days') * 100.0 / NULLIF(COUNT(*), 0) as rate
      FROM (
        SELECT memory_id FROM memory_recall_events
        WHERE recalled_at >= $1 AND recalled_at < $2 AND rank > 0${win.scopeFilter}
        LIMIT $LIMIT
      ) sub JOIN memories m ON m.id = sub.memory_id
    `);
    const freshResult = await this.pool.query(freshSql, freshParams);
    const freshRow = freshResult.rows[0] as RateRow | undefined;
    const freshRate = freshRow && freshRow.rate != null ? Number(freshRow.rate) || 0 : 0;

    const { sql: staleSql, params: staleParams } = this.buildQuery(win, `
      SELECT COUNT(*) FILTER (WHERE m.created_at < $1::timestamptz - interval '30 days') * 100.0 / NULLIF(COUNT(*), 0) as rate
      FROM (
        SELECT memory_id FROM memory_recall_events
        WHERE recalled_at >= $1 AND recalled_at < $2 AND rank > 0${win.scopeFilter}
        LIMIT $LIMIT
      ) sub JOIN memories m ON m.id = sub.memory_id
    `);
    const staleResult = await this.pool.query(staleSql, staleParams);
    const staleRow = staleResult.rows[0] as RateRow | undefined;
    const staleRate = staleRow && staleRow.rate != null ? Number(staleRow.rate) || 0 : 0;

    // Duplicate rate
    const { sql: dupSql, params: dupParams } = this.buildQuery(win, `
      SELECT
        COUNT(*) FILTER (WHERE memory_id IN (
          SELECT memory_id FROM (
            SELECT memory_id FROM memory_recall_events
            WHERE recalled_at >= $1 AND recalled_at < $2 AND rank > 0${win.scopeFilter}
            LIMIT $LIMIT
          ) dup_sub GROUP BY memory_id HAVING COUNT(*) > 1
        )) * 100.0 / NULLIF(COUNT(*), 0) as rate
      FROM (
        SELECT memory_id FROM memory_recall_events
        WHERE recalled_at >= $1 AND recalled_at < $2 AND rank > 0${win.scopeFilter}
        LIMIT $LIMIT
      ) sub
    `);
    const dupResult = await this.pool.query(dupSql, dupParams);
    const dupRow = dupResult.rows[0] as RateRow | undefined;
    const duplicateRate = dupRow && dupRow.rate != null ? Number(dupRow.rate) || 0 : 0;

    // Null memory_id rate (empty_result events with NULL memory_id)
    const { sql: nullSql, params: nullParams } = this.buildQuery(win, `
      SELECT
        COUNT(*) FILTER (WHERE memory_id IS NULL) as null_count,
        COUNT(*) as total
      FROM (
        SELECT memory_id FROM memory_recall_events
        WHERE recalled_at >= $1 AND recalled_at < $2${win.scopeFilter}
        LIMIT $LIMIT
      ) sub
    `);
    const nullResult = await this.pool.query(nullSql, nullParams);
    const nullRow = nullResult.rows[0] as NullRateRow | undefined;
    const nullCount = nullRow ? Number(nullRow.null_count) || 0 : 0;
    const nullTotal = nullRow ? Number(nullRow.total) || 0 : 0;
    const nullMemoryIdRate = nullTotal > 0 ? (nullCount / nullTotal) * 100 : 0;

    const graphEventCount = sourceDistribution['graph'] || 0;

    return {
      totalEvents, surfacesFired, surfacesMissing,
      surfaceCount: surfacesFired.length,
      top3Rate, mrr, emptyResultRate, searchRecallRate,
      freshRate, staleRate, duplicateRate, textFallbackRate,
      vectorHealthRate, lowResultRate, sourceDistribution,
      nullMemoryIdRate, graphEventCount, dialect,
    };
  }

  private async collectSections(win: AuditWindow): Promise<ReportSections> {
    return {
      relevance: await this.buildRelevanceSection(win),
      recallRate: await this.buildRecallRateSection(win),
      freshness: await this.buildFreshnessSection(win),
      stability: await this.buildStabilitySection(win),
      coverage: await this.buildCoverageSection(win),
      queryQuality: await this.buildQueryQualitySection(win),
    };
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
    // Relevance metrics: search sources only (context_recall is not a ranked search)
    const searchSourceFilter = `AND source IN ('search', 'vector_only', 'text_only', 'text_fallback')`;
    const { sql: top3Sql, params: top3Params } = this.buildQuery(win, `
      SELECT
        COUNT(*) FILTER (WHERE rank <= 3) * 100.0 / NULLIF(COUNT(*), 0) as rate,
        COUNT(*) FILTER (WHERE rank <= 3) as top3_count,
        COUNT(*) as total
      FROM (
        SELECT rank FROM memory_recall_events
        WHERE recalled_at >= $1 AND recalled_at < $2
          AND rank > 0${searchSourceFilter}${win.scopeFilter}
        LIMIT $LIMIT
      ) sub
    `);
    const { sql: mrrSql, params: mrrParams } = this.buildQuery(win, `
      SELECT AVG(1.0 / NULLIF(rank, 0)) as rate
      FROM (
        SELECT rank FROM memory_recall_events
        WHERE recalled_at >= $1 AND recalled_at < $2
          AND rank > 0${searchSourceFilter}${win.scopeFilter}
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
      SELECT ARRAY_AGG(DISTINCT source ORDER BY source) as sources
      FROM (
        SELECT source FROM memory_recall_events
        WHERE recalled_at >= $1 AND recalled_at < $2${win.scopeFilter}
        LIMIT $LIMIT
      ) sub
    `);

    const result = await this.pool.query(sql, params);
    const row = result.rows[0] as SurfacesRow | undefined;
    const surfaces = row?.sources || [];
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

  private degradedReport(win: AuditWindow, score?: RecallQualityScore): string {
    const scoreSection = score ? this.formatScoreSection(score) : '';
    return `Recall Quality Report
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Window: ${win.windowStart} → ${win.windowEnd}
Scope:  ${win.scope}
Surfaces observed: N/A (SQLite)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${scoreSection}
Note: Recall quality audit requires PostgreSQL (FILTER, interval, ARRAY_AGG).
SQLite recall events are still recorded and will be scored after migration to PG.`;
  }

  private formatScoreSection(score: RecallQualityScore): string {
    const gradeLabel: Record<RecallQualityGrade, string> = {
      healthy: 'HEALTHY',
      sparse_data: 'SPARSE DATA',
      needs_attention: 'NEEDS ATTENTION',
      degraded: 'DEGRADED',
      unknown: 'UNKNOWN',
    };
    const lines: string[] = [
      `Advisory Score: ${gradeLabel[score.grade]} (confidence: ${(score.confidence * 100).toFixed(0)}%)`,
      '',
      'Reasons:',
    ];
    for (const r of score.reasons) {
      lines.push(`  - ${r}`);
    }
    if (score.recommendations.length > 0) {
      lines.push('', 'Recommendations (advisory only — no automatic action taken):');
      for (const rec of score.recommendations) {
        lines.push(`  • ${rec}`);
      }
    }
    lines.push('━'.repeat(59));
    return lines.join('\n');
  }

  private formatReport(win: AuditWindow, metrics: RecallMetrics, sections: ReportSections, score?: RecallQualityScore): string {
    const scoreSection = score ? this.formatScoreSection(score) + '\n' : '';
    const distEntries = Object.entries(metrics.sourceDistribution)
      .map(([src, cnt]) => `${src}: ${cnt}`)
      .join(', ');

    const lines = [
      'Recall Quality Report',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `Window: ${win.windowStart} → ${win.windowEnd}`,
      `Scope:  ${win.scope}`,
      `Surfaces observed: ${metrics.surfaceCount}/8`,
      `Total events: ${metrics.totalEvents}`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      scoreSection,
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
      'Source Distribution',
      '───────────────────',
      distEntries || 'none',
      '',
      `Null memory_id rate: ${metrics.nullMemoryIdRate.toFixed(0)}% (empty_result events are valid)`,
      '',
      'Note: This is an advisory report (Phase 6B+6D). Scores are advisory only — no automatic action is taken.',
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

Note: This is a mock report (Phase 6D). Scores are advisory only — no automatic action is taken.`;
}

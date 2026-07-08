/**
 * Phase 6E: Continuity Resilience Report
 *
 * Read-only dashboard over the full CSM stack.
 * Reports health of memory, recall, graph, pipeline, living state, docs, and tools.
 * No mutations. No repairs. No auto-doc writes from this report.
 *
 * SQLite degrades per-field, not per-section.
 * Advisories explain the grade — they do not become the grade.
 * Knowledge signals (promoted beliefs) are informational only — 0% weight.
 */

import type { DatabasePool } from './types.js';
import type { Database } from './database.js';
import type { RecallMetrics, RecallQualityScore } from './recall-quality-tool.js';
import { scoreMetrics } from './recall-quality-tool.js';
import { CSM_TOOL_NAMES } from './tool-names.js';
import { dialectFromPool } from './db/query-dialect.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// Types
// ============================================================================

export type ContinuityGrade = 'healthy' | 'sparse_data' | 'needs_attention' | 'degraded' | 'unknown';

export interface SectionResult<T> {
  data: T | null;
  available: boolean;
  degraded: string[];
  grade: ContinuityGrade;
  gradeReason: string;
}

export interface ContinuityReport {
  memoryInventory: SectionResult<MemoryInventory>;
  recallHealth: SectionResult<RecallHealthData>;
  recallScore: RecallQualityScore | null;
  graphReadiness: SectionResult<GraphReadinessData>;
  pipelineStatus: SectionResult<PipelineStatusData>;
  livingState: SectionResult<LivingStateData>;
  docsFreshness: SectionResult<DocsFreshnessData>;
  toolRegistry: SectionResult<ToolRegistryData>;
  systemAdvisories: SystemAdvisory[];
  knowledgeSignals: KnowledgeSignals;
  continuityConfidence: ContinuityConfidence;
}

export interface MemoryInventory {
  total: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
}

export interface RecallHealthData {
  totalEvents: number;
  sourceDistribution: Record<string, number>;
  surfaceCount: number;
  surfacesFired: string[];
  shallowAvailable: boolean;
  deepMetrics: {
    top3Rate: number | null;
    mrr: number | null;
    emptyResultRate: number | null;
    freshRate: number | null;
    staleRate: number | null;
    vectorHealthRate: number | null;
    textFallbackRate: number | null;
    duplicateRate: number | null;
    nullMemoryIdRate: number | null;
  };
  metrics: RecallMetrics;
}

export interface GraphReadinessData {
  totalLinks: number;
  byLinkType: Record<string, number>;
  totalMemoriesWithLinks: number;
  totalMemories: number;
  linkCoveragePct: number;
}

export interface PipelineStatusData {
  totalPackets: number;
  packetsLast24h: number;
  candidatesByType: Record<string, number>;
  candidatesByStatus: Record<string, number>;
  promotionReadyBacklog: number;
  promotedBeliefCount: number;
}

export interface LivingStateData {
  enabled: boolean;
  injectAdvisoryBlock: boolean;
  blockProduced: boolean;
  sectionsPresent: string[];
  sectionsOmitted: string[];
  packetCount: number | null;
  candidateCount: number | null;
  capabilityCount: number | null;
}

export interface DocsFreshnessData {
  architecture: { exists: boolean; lastModified: string | null; ageHours: number | null };
  systemMap: { exists: boolean; lastModified: string | null; ageHours: number | null };
  agentsMd: { exists: boolean; lastModified: string | null; ageHours: number | null };
}

export interface ToolRegistryData {
  declaredTools: string[];
  registeredTools: string[];
  mismatchCount: number;
  undeclared: string[];
  unregistered: string[];
}

export interface SystemAdvisory {
  priority: number;
  source: string;
  message: string;
}

export interface KnowledgeSignals {
  topBeliefs: Array<{ subject: string; claim: string; confidence: number; kind: string }>;
  candidateBacklog: number;
  promotionReady: number;
  recentActivity: number;
}

export interface ContinuityConfidence {
  grade: ContinuityGrade;
  score: number;
  normalizedWeight: number;
  sectionGrades: Record<string, { grade: ContinuityGrade; weight: number; normalizedWeight: number }>;
}

// ============================================================================
// Weights (advisories 0%, knowledge signals 0%)
// ============================================================================

const WEIGHTS = {
  recall: 0.30,
  graph: 0.15,
  pipeline: 0.15,
  memoryInventory: 0.10,
  livingState: 0.10,
  docsFreshness: 0.10,
  toolRegistry: 0.10,
} as const;

// ============================================================================
// Section 1: Memory Inventory
// ============================================================================

async function collectMemoryInventory(pool: DatabasePool, dialect: string): Promise<SectionResult<MemoryInventory>> {
  try {
    const typeResult = await pool.query(
      dialect === 'sqlite'
        ? `SELECT memory_type, COUNT(*) as cnt FROM memories GROUP BY memory_type ORDER BY cnt DESC`
        : `SELECT memory_type, COUNT(*) as cnt FROM memories GROUP BY memory_type ORDER BY cnt DESC`,
    );
    const byType: Record<string, number> = {};
    let total = 0;
    for (const row of typeResult.rows as { memory_type: string; cnt: number | string }[]) {
      byType[row.memory_type] = Number(row.cnt) || 0;
      total += Number(row.cnt) || 0;
    }

    let byStatus: Record<string, number> = {};
    try {
      const statusResult = await pool.query(
        dialect === 'sqlite'
          ? `SELECT
              CASE WHEN superseded_at IS NOT NULL THEN 'superseded'
                   WHEN superseded_by IS NOT NULL THEN 'superseded'
                   ELSE 'active' END as status,
              COUNT(*) as cnt
             FROM memories GROUP BY status`
          : `SELECT
              CASE WHEN superseded_at IS NOT NULL THEN 'superseded'
                   WHEN superseded_by IS NOT NULL THEN 'superseded'
                   ELSE 'active' END as status,
              COUNT(*) as cnt
             FROM memories GROUP BY status`,
      );
      for (const row of statusResult.rows as { status: string; cnt: number | string }[]) {
        byStatus[row.status] = Number(row.cnt) || 0;
      }
    } catch {
      byStatus = { active: total };
    }

    const grade: ContinuityGrade = total > 100 ? 'healthy' : total > 0 ? 'sparse_data' : 'unknown';
    return {
      data: { total, byType, byStatus },
      available: true,
      degraded: [],
      grade,
      gradeReason: `${total} memories across ${Object.keys(byType).length} types`,
    };
  } catch {
    return { data: null, available: false, degraded: ['all'], grade: 'unknown', gradeReason: 'Failed to query memories table' };
  }
}

// ============================================================================
// Section 2: Recall Health (shallow cross-dialect, deep PG-only per-field)
// ============================================================================

async function collectRecallHealth(pool: DatabasePool, dialect: string, windowHours: number): Promise<SectionResult<RecallHealthData>> {
  const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const degraded: string[] = [];

  try {
    // Shallow: source distribution (cross-dialect)
    const distResult = await pool.query(
      `SELECT source, COUNT(*) as cnt FROM memory_recall_events
       WHERE recalled_at >= $1
       GROUP BY source ORDER BY cnt DESC`,
      [windowStart],
    );
    const sourceDistribution: Record<string, number> = {};
    let totalEvents = 0;
    for (const row of distResult.rows as { source: string; cnt: number | string }[]) {
      sourceDistribution[row.source] = Number(row.cnt) || 0;
      totalEvents += Number(row.cnt) || 0;
    }
    const surfacesFired = Object.keys(sourceDistribution);
    const surfaceCount = surfacesFired.length;

    const expectedSurfaces = ['search', 'list', 'context_recall', 'graph', 'vector_only', 'text_only', 'text_fallback', 'empty_result'];
    const surfacesMissing = expectedSurfaces.filter(s => !surfacesFired.includes(s));

    // Deep metrics: PG only, per-field degradation
    const deepMetrics: RecallHealthData['deepMetrics'] = {
      top3Rate: null, mrr: null, emptyResultRate: null,
      freshRate: null, staleRate: null, vectorHealthRate: null,
      textFallbackRate: null, duplicateRate: null, nullMemoryIdRate: null,
    };

    if (dialect === 'pg') {
      try {
        const deepResult = await pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE rank <= 3) * 100.0 / NULLIF(COUNT(*), 0) as top3_rate,
            AVG(1.0 / NULLIF(rank, 0)) as mrr,
            COUNT(*) FILTER (WHERE source = 'empty_result') * 100.0 / NULLIF(COUNT(*), 0) as empty_rate,
            COUNT(*) FILTER (WHERE memory_id IS NULL) * 100.0 / NULLIF(COUNT(*), 0) as null_rate
          FROM memory_recall_events
          WHERE recalled_at >= $1 AND rank > 0
        `, [windowStart]);
        const d = deepResult.rows[0] as Record<string, string | number | null> | undefined;
        if (d) {
          deepMetrics.top3Rate = d.top3_rate != null ? Number(d.top3_rate) || 0 : null;
          deepMetrics.mrr = d.mrr != null ? Number(d.mrr) || 0 : null;
          deepMetrics.emptyResultRate = d.empty_rate != null ? Number(d.empty_rate) || 0 : null;
          deepMetrics.nullMemoryIdRate = d.null_rate != null ? Number(d.null_rate) || 0 : null;
        }
      } catch { degraded.push('top3Rate', 'mrr', 'emptyResultRate', 'nullMemoryIdRate'); }

      try {
        const fbResult = await pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE source IN ('text_fallback', 'text_only')) * 100.0 / NULLIF(COUNT(*), 0) as fb_rate,
            COUNT(*) FILTER (WHERE source = 'graph') as graph_count
          FROM memory_recall_events WHERE recalled_at >= $1
        `, [windowStart]);
        const f = fbResult.rows[0] as Record<string, string | number | null> | undefined;
        if (f) {
          deepMetrics.textFallbackRate = f.fb_rate != null ? Number(f.fb_rate) || 0 : null;
        }
      } catch { degraded.push('textFallbackRate'); }

      try {
        const vecResult = await pool.query(`
          SELECT COUNT(*) FILTER (WHERE m.embedding IS NOT NULL) * 100.0 / NULLIF(COUNT(*), 0) as vec_rate
          FROM memory_recall_events r
          JOIN memories m ON m.id = r.memory_id
          WHERE r.recalled_at >= $1 AND r.rank > 0
        `, [windowStart]);
        const v = vecResult.rows[0] as Record<string, string | number | null> | undefined;
        if (v) deepMetrics.vectorHealthRate = v.vec_rate != null ? Number(v.vec_rate) || 0 : null;
      } catch { degraded.push('vectorHealthRate'); }
    } else {
      degraded.push('top3Rate', 'mrr', 'freshRate', 'staleRate', 'vectorHealthRate', 'duplicateRate');
    }

    const metrics: RecallMetrics = {
      totalEvents, surfacesFired, surfacesMissing, surfaceCount,
      top3Rate: deepMetrics.top3Rate ?? 0,
      mrr: deepMetrics.mrr ?? 0,
      emptyResultRate: deepMetrics.emptyResultRate ?? 0,
      searchRecallRate: totalEvents > 0 ? ((sourceDistribution['search'] || 0) / totalEvents) * 100 : 0,
      freshRate: deepMetrics.freshRate ?? 0,
      staleRate: deepMetrics.staleRate ?? 0,
      duplicateRate: deepMetrics.duplicateRate ?? 0,
      textFallbackRate: deepMetrics.textFallbackRate ?? 0,
      vectorHealthRate: deepMetrics.vectorHealthRate ?? 0,
      lowResultRate: 0,
      sourceDistribution,
      nullMemoryIdRate: deepMetrics.nullMemoryIdRate ?? 0,
      graphEventCount: sourceDistribution['graph'] || 0,
      dialect,
    };

    const grade: ContinuityGrade =
      totalEvents === 0 ? 'unknown' :
      totalEvents < 10 ? 'sparse_data' :
      surfaceCount < 3 && totalEvents < 50 ? 'sparse_data' :
      (deepMetrics.textFallbackRate != null && deepMetrics.textFallbackRate > 40) ? 'needs_attention' :
      (deepMetrics.emptyResultRate != null && deepMetrics.emptyResultRate > 50) ? 'needs_attention' :
      'healthy';

    return {
      data: { totalEvents, sourceDistribution, surfaceCount, surfacesFired, shallowAvailable: true, deepMetrics, metrics },
      available: true,
      degraded,
      grade,
      gradeReason: `${totalEvents} events, ${surfaceCount}/8 surfaces fired`,
    };
  } catch {
    return { data: null, available: false, degraded: ['all'], grade: 'unknown', gradeReason: 'Failed to query recall events' };
  }
}

// ============================================================================
// Section 4: Graph Readiness
// ============================================================================

async function collectGraphReadiness(pool: DatabasePool, _dialect: string): Promise<SectionResult<GraphReadinessData>> {
  try {
    const linkResult = await pool.query(
      `SELECT link_type, COUNT(*) as cnt FROM memory_links GROUP BY link_type ORDER BY cnt DESC`,
    );
    const byLinkType: Record<string, number> = {};
    let totalLinks = 0;
    for (const row of linkResult.rows as { link_type: string; cnt: number | string }[]) {
      byLinkType[row.link_type] = Number(row.cnt) || 0;
      totalLinks += Number(row.cnt) || 0;
    }

    const memResult = await pool.query(`SELECT COUNT(DISTINCT source_id) + COUNT(DISTINCT target_id) - COUNT(DISTINCT CASE WHEN source_id = target_id THEN source_id END) as linked FROM memory_links`);
    const totalMemoriesWithLinks = Number((memResult.rows[0] as { linked: number | string }).linked) || 0;

    const totalMemResult = await pool.query(`SELECT COUNT(*) as cnt FROM memories`);
    const totalMemories = Number((totalMemResult.rows[0] as { cnt: number | string }).cnt) || 0;

    const linkCoveragePct = totalMemories > 0 ? (totalMemoriesWithLinks / totalMemories) * 100 : 0;

    const grade: ContinuityGrade =
      totalLinks === 0 ? 'sparse_data' :
      linkCoveragePct < 5 ? 'sparse_data' :
      linkCoveragePct < 20 ? 'needs_attention' :
      'healthy';

    return {
      data: { totalLinks, byLinkType, totalMemoriesWithLinks, totalMemories, linkCoveragePct },
      available: true,
      degraded: [],
      grade,
      gradeReason: `${totalLinks} links, ${totalMemoriesWithLinks}/${totalMemories} memories linked (${linkCoveragePct.toFixed(0)}%)`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { data: null, available: false, degraded: ['all'], grade: 'unknown', gradeReason: `Failed to query memory_links: ${msg}` };
  }
}

// ============================================================================
// Section 5: Pipeline Status
// ============================================================================

async function collectPipelineStatus(pool: DatabasePool): Promise<SectionResult<PipelineStatusData>> {
  try {
    const packetResult = await pool.query(`SELECT COUNT(*) as cnt FROM experience_packets`);
    const totalPackets = Number((packetResult.rows[0] as { cnt: number | string }).cnt) || 0;

    const recentResult = await pool.query(
      `SELECT COUNT(*) as cnt FROM experience_packets WHERE created_at >= $1`,
      [new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()],
    );
    const packetsLast24h = Number((recentResult.rows[0] as { cnt: number | string }).cnt) || 0;

    const candidatesByType: Record<string, number> = {};
    const candidatesByStatus: Record<string, number> = {};
    try {
      const typeResult = await pool.query(`SELECT candidate_type, COUNT(*) as cnt FROM memory_candidate_queue GROUP BY candidate_type`);
      for (const row of typeResult.rows as { candidate_type: string; cnt: number | string }[]) {
        candidatesByType[row.candidate_type] = Number(row.cnt) || 0;
      }
      const statusResult = await pool.query(`SELECT status, COUNT(*) as cnt FROM memory_candidate_queue GROUP BY status`);
      for (const row of statusResult.rows as { status: string; cnt: number | string }[]) {
        candidatesByStatus[row.status] = Number(row.cnt) || 0;
      }
    } catch { /* SQLite might not have the table */ }

    let promotionReadyBacklog = 0;
    try {
      const readyResult = await pool.query(
        `SELECT COUNT(*) as cnt FROM memory_candidate_queue WHERE status = 'pending' AND promotion_ready = 1`,
      );
      promotionReadyBacklog = Number((readyResult.rows[0] as { cnt: number | string }).cnt) || 0;
    } catch { /* tolerate */ }

    let promotedBeliefCount = 0;
    try {
      const beliefResult = await pool.query(`SELECT COUNT(*) as cnt FROM belief_knowledge_store WHERE status = 'promoted'`);
      promotedBeliefCount = Number((beliefResult.rows[0] as { cnt: number | string }).cnt) || 0;
    } catch { /* tolerate */ }

    const grade: ContinuityGrade =
      totalPackets === 0 ? 'unknown' :
      packetsLast24h === 0 ? 'sparse_data' :
      'healthy';

    return {
      data: { totalPackets, packetsLast24h, candidatesByType, candidatesByStatus, promotionReadyBacklog, promotedBeliefCount },
      available: true,
      degraded: [],
      grade,
      gradeReason: `${totalPackets} packets, ${packetsLast24h} in last 24h, ${promotionReadyBacklog} ready, ${promotedBeliefCount} promoted`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { data: null, available: false, degraded: ['all'], grade: 'unknown', gradeReason: `Failed to query pipeline tables: ${msg}` };
  }
}

// ============================================================================
// Section 6: Living State
// ============================================================================

async function collectLivingState(pool: DatabasePool, _dialect: string): Promise<SectionResult<LivingStateData>> {
  try {
    let enabled = false; const injectAdvisoryBlock = false; const blockProduced = false;
    let sectionsPresent: string[] = [], sectionsOmitted: string[] = [];
    let packetCount: number | null = null, candidateCount: number | null = null, capabilityCount: number | null = null;

    try {
      const configResult = await pool.query(
        `SELECT value FROM csm_config WHERE key = 'living_state.enabled'`,
      );
      if (configResult.rows.length > 0) {
        enabled = (configResult.rows[0] as { value: string }).value === 'true';
      } else {
        enabled = true;
      }
    } catch {
      enabled = true;
    }

    // Count recent packets and candidates as a proxy for living state health
    try {
      const pResult = await pool.query(`SELECT COUNT(*) as cnt FROM experience_packets`);
      packetCount = Number((pResult.rows[0] as { cnt: number | string }).cnt) || 0;
    } catch { packetCount = null; }

    try {
      const cResult = await pool.query(`SELECT COUNT(*) as cnt FROM memory_candidate_queue WHERE status = 'pending'`);
      candidateCount = Number((cResult.rows[0] as { cnt: number | string }).cnt) || 0;
    } catch { candidateCount = null; }

    try {
      const capResult = await pool.query(`SELECT COUNT(*) as cnt FROM self_model_capabilities`);
      capabilityCount = Number((capResult.rows[0] as { cnt: number | string }).cnt) || 0;
    } catch { capabilityCount = null; }

    sectionsPresent = [];
    if (packetCount != null && packetCount > 0) sectionsPresent.push('internalState');
    if (candidateCount != null && candidateCount > 0) sectionsPresent.push('candidateBeliefs');
    if (capabilityCount != null && capabilityCount > 0) sectionsPresent.push('capabilityNotes');
    sectionsOmitted = ['internalState', 'recentSignals', 'candidateBeliefs', 'capabilityNotes', 'warnings'].filter(
      s => !sectionsPresent.includes(s),
    );

    const grade: ContinuityGrade =
      !enabled ? 'unknown' :
      packetCount == null ? 'sparse_data' :
      packetCount === 0 ? 'unknown' :
      'healthy';

    return {
      data: { enabled, injectAdvisoryBlock, blockProduced, sectionsPresent, sectionsOmitted, packetCount, candidateCount, capabilityCount },
      available: true,
      degraded: packetCount == null ? ['packetCount'] : [],
      grade,
      gradeReason: enabled ? `enabled, ${packetCount ?? 'N/A'} packets, ${candidateCount ?? 'N/A'} candidates, ${capabilityCount ?? 'N/A'} capabilities` : 'disabled',
    };
  } catch {
    return { data: null, available: false, degraded: ['all'], grade: 'unknown', gradeReason: 'Living state unavailable' };
  }
}

// ============================================================================
// Section 7: Docs Freshness
// ============================================================================

export async function collectDocsFreshness(workspaceDir: string): Promise<SectionResult<DocsFreshnessData>> {
  try {
    const docsDir = path.join(workspaceDir, 'docs');
    const checkFile = (filename: string) => {
      const fullPath = path.join(docsDir, filename);
      if (!fs.existsSync(fullPath)) {
        return { exists: false, lastModified: null, ageHours: null };
      }
      const stat = fs.statSync(fullPath);
      const ageMs = Date.now() - stat.mtimeMs;
      const ageHours = ageMs / (1000 * 60 * 60);
      return { exists: true, lastModified: stat.mtime.toISOString(), ageHours };
    };

    const architecture = checkFile('ARCHITECTURE.md');
    const systemMap = checkFile('SYSTEM_MAP.md');
    const agentsMdPath = path.join(workspaceDir, 'AGENTS.md');
    const agentsMd = fs.existsSync(agentsMdPath)
      ? { exists: true, lastModified: fs.statSync(agentsMdPath).mtime.toISOString(), ageHours: (Date.now() - fs.statSync(agentsMdPath).mtimeMs) / (1000 * 60 * 60) }
      : { exists: false, lastModified: null, ageHours: null };

    const allExist = architecture.exists && systemMap.exists && agentsMd.exists;
    const oldestAge = [architecture.ageHours, systemMap.ageHours, agentsMd.ageHours]
      .filter((x): x is number => x != null)
      .reduce((a, b) => Math.max(a, b), 0);

    const grade: ContinuityGrade =
      !allExist ? 'needs_attention' :
      oldestAge > 168 ? 'needs_attention' :
      oldestAge > 24 ? 'sparse_data' :
      'healthy';

    return {
      data: { architecture, systemMap, agentsMd },
      available: true,
      degraded: [],
      grade,
      gradeReason: allExist ? `All docs present, oldest ${oldestAge.toFixed(0)}h old` : 'Some docs missing',
    };
  } catch {
    return { data: null, available: false, degraded: ['all'], grade: 'unknown', gradeReason: 'Failed to stat docs' };
  }
}

// ============================================================================
// Section 8: Tool Registry Health
// ============================================================================

export function collectToolRegistryHealth(registeredToolMap: Record<string, unknown>): SectionResult<ToolRegistryData> {
  try {
    // CSM_TOOL_NAMES is imported statically
    const declaredTools = CSM_TOOL_NAMES as readonly string[];
    const declaredSet = new Set(declaredTools);
    const registeredSet = new Set(Object.keys(registeredToolMap));

    const undeclared = [...registeredSet].filter(t => !declaredSet.has(t));
    const unregistered = [...declaredSet].filter(t => !registeredSet.has(t));
    const mismatchCount = undeclared.length + unregistered.length;

    const grade: ContinuityGrade =
      mismatchCount === 0 ? 'healthy' :
      mismatchCount <= 2 ? 'needs_attention' :
      'degraded';

    return {
      data: { declaredTools: [...declaredTools], registeredTools: [...registeredSet], mismatchCount, undeclared, unregistered },
      available: true,
      degraded: [],
      grade,
      gradeReason: mismatchCount === 0 ? `${declaredTools.length} tools, all registered` : `${mismatchCount} mismatches (${unregistered.length} unregistered, ${undeclared.length} undeclared)`,
    };
  } catch {
    return { data: null, available: false, degraded: ['all'], grade: 'unknown', gradeReason: 'Failed to compare tool registry' };
  }
}

// ============================================================================
// Section 9a: System Health Advisories (derived from sections, 0% weight)
// ============================================================================

export function collectSystemHealthAdvisories(report: Omit<ContinuityReport, 'systemAdvisories' | 'knowledgeSignals' | 'continuityConfidence'>): SystemAdvisory[] {
  const advisories: SystemAdvisory[] = [];

  // Priority 1: Tool registry mismatch
  if (report.toolRegistry.data && report.toolRegistry.data.mismatchCount > 0) {
    advisories.push({
      priority: 1, source: 'tool_registry',
      message: `Tool registry has ${report.toolRegistry.data.mismatchCount} mismatches: ${report.toolRegistry.data.unregistered.length} unregistered, ${report.toolRegistry.data.undeclared.length} undeclared`,
    });
  }

  // Priority 2: Docs stale or missing
  if (report.docsFreshness.data) {
    const d = report.docsFreshness.data;
    if (!d.architecture.exists) advisories.push({ priority: 2, source: 'docs', message: 'ARCHITECTURE.md is missing' });
    if (!d.systemMap.exists) advisories.push({ priority: 2, source: 'docs', message: 'SYSTEM_MAP.md is missing' });
    if (!d.agentsMd.exists) advisories.push({ priority: 2, source: 'docs', message: 'AGENTS.md is missing' });
    if (d.architecture.ageHours != null && d.architecture.ageHours > 168) {
      advisories.push({ priority: 2, source: 'docs', message: `ARCHITECTURE.md is ${d.architecture.ageHours.toFixed(0)}h old (>7 days). Auto-docs may not be updating.` });
    }
    if (d.systemMap.ageHours != null && d.systemMap.ageHours > 168) {
      advisories.push({ priority: 2, source: 'docs', message: `SYSTEM_MAP.md is ${d.systemMap.ageHours.toFixed(0)}h old (>7 days). Auto-docs may not be updating.` });
    }
  }

  // Priority 3: Recall quality warning
  if (report.recallScore && (report.recallScore.grade === 'needs_attention' || report.recallScore.grade === 'degraded')) {
    for (const reason of report.recallScore.reasons) {
      advisories.push({ priority: 3, source: 'recall', message: reason });
    }
  }

  // Priority 4: Graph sparse
  if (report.graphReadiness.data && report.graphReadiness.data.linkCoveragePct < 5) {
    advisories.push({
      priority: 4, source: 'graph',
      message: `Graph coverage is ${report.graphReadiness.data.linkCoveragePct.toFixed(1)}% (${report.graphReadiness.data.totalMemoriesWithLinks}/${report.graphReadiness.data.totalMemories} memories have links). This may be expected if relationship extraction is not widely used.`,
    });
  }

  // Priority 5: Pipeline stale
  if (report.pipelineStatus.data && report.pipelineStatus.data.packetsLast24h === 0 && report.pipelineStatus.data.totalPackets > 0) {
    advisories.push({
      priority: 5, source: 'pipeline',
      message: 'No new experience packets in the last 24h. Pipeline may be inactive.',
    });
  }
  if (report.pipelineStatus.data && report.pipelineStatus.data.totalPackets === 0) {
    advisories.push({
      priority: 5, source: 'pipeline',
      message: 'No experience packets recorded. Pipeline has never run or table is empty.',
    });
  }

  // Priority 6: Auto-docs not running (docs haven't been modified this session)
  if (report.docsFreshness.data) {
    const d = report.docsFreshness.data;
    if (d.architecture.ageHours != null && d.architecture.ageHours > 2 && d.architecture.exists) {
      advisories.push({
        priority: 6, source: 'auto_docs',
        message: 'ARCHITECTURE.md was last modified >2h ago. Auto-docs flush may not be running.',
      });
    }
  }

  return advisories.sort((a, b) => a.priority - b.priority);
}

// ============================================================================
// Section 9b: Knowledge Signals (informational only, 0% weight)
// ============================================================================

async function collectKnowledgeSignals(pool: DatabasePool): Promise<KnowledgeSignals> {
  try {
    let topBeliefs: KnowledgeSignals['topBeliefs'] = [];
    try {
      const beliefResult = await pool.query(
        `SELECT subject, claim, confidence, belief_kind FROM belief_knowledge_store ORDER BY confidence DESC LIMIT 5`,
      );
      topBeliefs = (beliefResult.rows as { subject: string; claim: string; confidence: number | string; belief_kind: string }[]).map(b => ({
        subject: b.subject, claim: b.claim, confidence: Number(b.confidence) || 0, kind: b.belief_kind,
      }));
    } catch { /* table may not exist */ }

    let candidateBacklog = 0, promotionReady = 0, recentActivity = 0;
    try {
      const backlogResult = await pool.query(`SELECT COUNT(*) as cnt FROM memory_candidate_queue WHERE status = 'pending'`);
      candidateBacklog = Number((backlogResult.rows[0] as { cnt: number | string }).cnt) || 0;
    } catch { /* tolerate */ }
    try {
      const readyResult = await pool.query(`SELECT COUNT(*) as cnt FROM memory_candidate_queue WHERE status = 'pending' AND promotion_ready = 1`);
      promotionReady = Number((readyResult.rows[0] as { cnt: number | string }).cnt) || 0;
    } catch { /* tolerate */ }
    try {
      const recentResult = await pool.query(
        `SELECT COUNT(*) as cnt FROM memory_candidate_queue WHERE created_at >= $1`,
        [new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()],
      );
      recentActivity = Number((recentResult.rows[0] as { cnt: number | string }).cnt) || 0;
    } catch { /* tolerate */ }

    return { topBeliefs, candidateBacklog, promotionReady, recentActivity };
  } catch {
    return { topBeliefs: [], candidateBacklog: 0, promotionReady: 0, recentActivity: 0 };
  }
}

// ============================================================================
// Section 10: Composite Continuity Confidence
// ============================================================================

export function computeContinuityConfidence(
  sections: Pick<ContinuityReport,
    'memoryInventory' | 'recallHealth' | 'graphReadiness' | 'pipelineStatus' | 'livingState' | 'docsFreshness' | 'toolRegistry'
  >,
): ContinuityConfidence {
  const gradeScore: Record<ContinuityGrade, number> = {
    healthy: 100, sparse_data: 60, needs_attention: 30, degraded: 10, unknown: 0,
  };

  const sectionKeys: Array<[keyof typeof sections, number]> = [
    ['recallHealth', WEIGHTS.recall],
    ['graphReadiness', WEIGHTS.graph],
    ['pipelineStatus', WEIGHTS.pipeline],
    ['memoryInventory', WEIGHTS.memoryInventory],
    ['livingState', WEIGHTS.livingState],
    ['docsFreshness', WEIGHTS.docsFreshness],
    ['toolRegistry', WEIGHTS.toolRegistry],
  ];

  const sectionGrades: Record<string, { grade: ContinuityGrade; weight: number; normalizedWeight: number }> = {};
  let totalScore = 0;
  let totalWeight = 0;

  for (const [key, weight] of sectionKeys) {
    const section = sections[key];
    const grade = section.available ? section.grade : 'unknown';
    const gScore = section.available ? gradeScore[grade] : 0;
    totalScore += gScore * weight;
    totalWeight += section.available ? weight : 0;
    sectionGrades[key] = { grade, weight, normalizedWeight: 0 };
  }

  // Re-normalize: if section unavailable, redistribute its weight
  if (totalWeight === 0) {
    return {
      grade: 'unknown',
      score: 0,
      normalizedWeight: 0,
      sectionGrades,
    };
  }

  // Less than 50% of total weight available → unknown
  if (totalWeight < 0.50) {
    return {
      grade: 'unknown',
      score: 0,
      normalizedWeight: totalWeight,
      sectionGrades,
    };
  }

  for (const key of Object.keys(sectionGrades)) {
    sectionGrades[key].normalizedWeight = sectionGrades[key].weight / totalWeight;
  }

  const score = totalScore / totalWeight;

  const grade: ContinuityGrade =
    score >= 80 ? 'healthy' :
    score >= 50 ? 'sparse_data' :
    score >= 25 ? 'needs_attention' :
    'degraded';

  return { grade, score: Math.round(score), normalizedWeight: totalWeight, sectionGrades };
}

// ============================================================================
// Format Report
// ============================================================================

function formatReport(report: ContinuityReport): string {
  const lines: string[] = [];
  const bar = '━'.repeat(59);

  lines.push('Continuity Resilience Report', bar);
  lines.push(`Overall: ${report.continuityConfidence.grade.toUpperCase()} (score: ${report.continuityConfidence.score}/100, weight: ${(report.continuityConfidence.normalizedWeight * 100).toFixed(0)}%)`);
  lines.push(bar);

  // Section 1: Memory Inventory
  const mi = report.memoryInventory;
  if (mi.available && mi.data) {
    const typeEntries = Object.entries(mi.data.byType).map(([t, c]) => `${t}: ${c}`).join(', ');
    const statusEntries = Object.entries(mi.data.byStatus).map(([s, c]) => `${s}: ${c}`).join(', ');
    lines.push('', `1. Memory Inventory [${mi.grade.toUpperCase()}]`, '───────────────────────────');
    lines.push(`   Total: ${mi.data.total}`);
    lines.push(`   By type: ${typeEntries}`);
    lines.push(`   By status: ${statusEntries}`);
  } else {
    lines.push('', '1. Memory Inventory [UNAVAILABLE]', '───────────────────────────', '   N/A');
  }

  // Section 2: Recall Health
  const rh = report.recallHealth;
  if (rh.available && rh.data) {
    const d = rh.data;
    lines.push('', `2. Recall Health [${rh.grade.toUpperCase()}]`, '───────────────────────────');
    lines.push(`   Total events (window): ${d.totalEvents}`);
    lines.push(`   Surfaces: ${d.surfaceCount}/8 fired (${d.surfacesFired.join(', ') || 'none'})`);
    if (rh.degraded.length > 0) {
      lines.push(`   Deep metrics N/A (requires PG): ${rh.degraded.join(', ')}`);
    }
    if (d.deepMetrics.top3Rate != null) lines.push(`   Top-3 rate: ${d.deepMetrics.top3Rate.toFixed(0)}%`);
    if (d.deepMetrics.mrr != null) lines.push(`   MRR: ${d.deepMetrics.mrr.toFixed(2)}`);
    if (d.deepMetrics.vectorHealthRate != null) lines.push(`   Vector health: ${d.deepMetrics.vectorHealthRate.toFixed(0)}%`);
    if (d.deepMetrics.textFallbackRate != null) lines.push(`   Text fallback: ${d.deepMetrics.textFallbackRate.toFixed(0)}%`);
    if (d.deepMetrics.emptyResultRate != null) lines.push(`   Empty result rate: ${d.deepMetrics.emptyResultRate.toFixed(0)}%`);
    if (d.deepMetrics.nullMemoryIdRate != null) lines.push(`   Null memory_id rate: ${d.deepMetrics.nullMemoryIdRate.toFixed(0)}%`);

    if (report.recallScore) {
      lines.push(`   Score: ${report.recallScore.grade.toUpperCase()} (confidence ${(report.recallScore.confidence * 100).toFixed(0)}%)`);
      for (const r of report.recallScore.reasons) lines.push(`     - ${r}`);
    }
  } else {
    lines.push('', '2. Recall Health [UNAVAILABLE]', '───────────────────────────', '   N/A');
  }

  // Section 4: Graph Readiness
  const gr = report.graphReadiness;
  if (gr.available && gr.data) {
    const d = gr.data;
    lines.push('', `4. Graph Readiness [${gr.grade.toUpperCase()}]`, '───────────────────────────');
    lines.push(`   Total links: ${d.totalLinks}`);
    const linkEntries = Object.entries(d.byLinkType).map(([t, c]) => `${t}: ${c}`).join(', ');
    lines.push(`   By type: ${linkEntries || 'none'}`);
    lines.push(`   Link coverage: ${d.linkCoveragePct.toFixed(1)}% (${d.totalMemoriesWithLinks}/${d.totalMemories} memories)`);
  } else {
    lines.push('', '4. Graph Readiness [UNAVAILABLE]', '───────────────────────────', `   N/A (${gr.gradeReason})`);
  }

  // Section 5: Pipeline Status
  const ps = report.pipelineStatus;
  if (ps.available && ps.data) {
    const d = ps.data;
    lines.push('', `5. Pipeline Status [${ps.grade.toUpperCase()}]`, '───────────────────────────');
    lines.push(`   Total packets: ${d.totalPackets} (${d.packetsLast24h} in last 24h)`);
    lines.push(`   Candidate queue: ${d.candidatesByStatus.pending || 0} pending, ${d.candidatesByStatus.applied || 0} applied, ${d.candidatesByStatus.skipped || 0} skipped`);
    lines.push(`   Promotion-ready: ${d.promotionReadyBacklog}`);
    lines.push(`   Promoted beliefs: ${d.promotedBeliefCount}`);
  } else {
    lines.push('', '5. Pipeline Status [UNAVAILABLE]', '───────────────────────────', `   N/A (${ps.gradeReason})`);
  }

  // Section 6: Living State
  const ls = report.livingState;
  if (ls.available && ls.data) {
    const d = ls.data;
    lines.push('', `6. Living State [${ls.grade.toUpperCase()}]`, '───────────────────────────');
    lines.push(`   Enabled: ${d.enabled ? 'yes' : 'no'}`);
    lines.push(`   Sections present: ${d.sectionsPresent.join(', ') || 'none'}`);
    lines.push(`   Sections omitted: ${d.sectionsOmitted.join(', ') || 'none'}`);
    lines.push(`   Packets: ${d.packetCount ?? 'N/A'} | Candidates: ${d.candidateCount ?? 'N/A'} | Capabilities: ${d.capabilityCount ?? 'N/A'}`);
  } else {
    lines.push('', '6. Living State [UNAVAILABLE]', '───────────────────────────', '   N/A');
  }

  // Section 7: Docs Freshness
  const df = report.docsFreshness;
  if (df.available && df.data) {
    const d = df.data;
    lines.push('', `7. Docs Freshness [${df.grade.toUpperCase()}]`, '───────────────────────────');
    lines.push(`   ARCHITECTURE.md: ${d.architecture.exists ? `${d.architecture.ageHours?.toFixed(0)}h old` : 'missing'}`);
    lines.push(`   SYSTEM_MAP.md: ${d.systemMap.exists ? `${d.systemMap.ageHours?.toFixed(0)}h old` : 'missing'}`);
    lines.push(`   AGENTS.md: ${d.agentsMd.exists ? `${d.agentsMd.ageHours?.toFixed(0)}h old` : 'missing'}`);
  } else {
    lines.push('', '7. Docs Freshness [UNAVAILABLE]', '───────────────────────────', '   N/A');
  }

  // Section 8: Tool Registry
  const tr = report.toolRegistry;
  if (tr.available && tr.data) {
    const d = tr.data;
    lines.push('', `8. Tool Registry [${tr.grade.toUpperCase()}]`, '───────────────────────────');
    lines.push(`   Declared: ${d.declaredTools.length}`);
    lines.push(`   Registered: ${d.registeredTools.length}`);
    if (d.mismatchCount > 0) {
      if (d.unregistered.length > 0) lines.push(`   Unregistered (declared but not wired): ${d.unregistered.join(', ')}`);
      if (d.undeclared.length > 0) lines.push(`   Undeclared (wired but not in CSM_TOOL_NAMES): ${d.undeclared.join(', ')}`);
    } else {
      lines.push('   No mismatches');
    }
  } else {
    lines.push('', '8. Tool Registry [UNAVAILABLE]', '───────────────────────────', '   N/A');
  }

  // Section 9a: System Health Advisories
  lines.push('', '9a. System Health Advisories', '───────────────────────────');
  if (report.systemAdvisories.length === 0) {
    lines.push('   No advisories. All sections healthy.');
  } else {
    for (const a of report.systemAdvisories) {
      lines.push(`   [P${a.priority}] (${a.source}) ${a.message}`);
    }
  }

  // Section 9b: Knowledge Signals
  const ks = report.knowledgeSignals;
  lines.push('', '9b. Knowledge Signals (informational — 0% weight)', '───────────────────────────');
  lines.push(`   Candidate backlog: ${ks.candidateBacklog}`);
  lines.push(`   Promotion-ready: ${ks.promotionReady}`);
  lines.push(`   Recent activity (7d): ${ks.recentActivity}`);
  if (ks.topBeliefs.length > 0) {
    lines.push('   Top beliefs:');
    for (const b of ks.topBeliefs) {
      lines.push(`     - (${b.confidence.toFixed(2)}) ${b.kind}: ${b.subject} — ${b.claim.slice(0, 100)}`);
    }
  } else {
    lines.push('   Top beliefs: none');
  }

  // Section 10: Composite Confidence
  const cc = report.continuityConfidence;
  lines.push('', '10. Continuity Confidence', '───────────────────────────');
  lines.push(`   Grade: ${cc.grade.toUpperCase()}`);
  lines.push(`   Score: ${cc.score}/100`);
  lines.push(`   Available weight: ${(cc.normalizedWeight * 100).toFixed(0)}%`);
  for (const [key, sg] of Object.entries(cc.sectionGrades)) {
    lines.push(`   ${key}: ${sg.grade.toUpperCase()} (${(sg.normalizedWeight * 100).toFixed(0)}%)`);
  }

  lines.push('', bar);
  lines.push('This is an advisory report (Phase 6E). No mutations. No repairs. No auto-action.');
  return lines.join('\n');
}

// ============================================================================
// Main Entry Point
// ============================================================================

export async function buildContinuityResilienceReport(
  database: Database,
  workspaceDir: string,
  toolMap: Record<string, unknown>,
  windowHours: number = 24,
): Promise<string> {
  const pool = database.getPool();
  const dialect = dialectFromPool(pool);

  const memoryInventory = await collectMemoryInventory(pool, dialect);
  const recallHealth = await collectRecallHealth(pool, dialect, windowHours);
  const recallScore = recallHealth.available && recallHealth.data ? scoreMetrics(recallHealth.data.metrics) : null;
  const graphReadiness = await collectGraphReadiness(pool, dialect);
  const pipelineStatus = await collectPipelineStatus(pool);
  const livingState = await collectLivingState(pool, dialect);
  const docsFreshness = await collectDocsFreshness(workspaceDir);
  const toolRegistry = collectToolRegistryHealth(toolMap);

  const partial = { memoryInventory, recallHealth, recallScore, graphReadiness, pipelineStatus, livingState, docsFreshness, toolRegistry };
  const systemAdvisories = collectSystemHealthAdvisories(partial);
  const knowledgeSignals = await collectKnowledgeSignals(pool);
  const continuityConfidence = computeContinuityConfidence(partial);

  const report: ContinuityReport = {
    ...partial,
    systemAdvisories,
    knowledgeSignals,
    continuityConfidence,
  };

  return formatReport(report);
}

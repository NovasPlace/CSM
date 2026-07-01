import type { Database } from './database.js';

type CandidateKind = 'lowQuality' | 'stale' | 'lowAccess' | 'supersededDuplicates' | 'typeSpecificJunk';

export interface GovernanceReportConfig {
  projectId?: string;
  maxPerCategory?: number;
  staleDays?: number;
  lowQualityMaxScore?: number;
  lowAccessMax?: number;
}

export interface GovernanceCandidate {
  memoryId: number;
  memoryType: string;
  reason: string;
  score: number | null;
  band: string | null;
  ageDays: number;
  accessCount: number;
  recallCount: number;
  snippet: string;
  supersededBy: number | null;
}

export interface GovernanceBucket {
  count: number;
  byType: Record<string, number>;
  samples: GovernanceCandidate[];
}

export interface GovernanceReport {
  generatedAt: string;
  projectId: string | null;
  scannedTotal: number;
  activeMemories: number;
  scoredActive: number;
  supersededMemories: number;
  categoryCounts: Record<CandidateKind, number>;
  categories: Record<CandidateKind, GovernanceBucket>;
}

interface MemoryRow {
  id: number; memory_type: string; content: string; created_at: Date; accessed_at: Date | null;
  access_count: number; superseded_by: number | null; quality_score: number | null; quality_band: string | null;
  recall_count: number;
}

interface GovernanceRules {
  maxPerCategory: number;
  staleDays: number;
  lowQualityMaxScore: number;
  lowAccessMax: number;
}

const DEFAULTS = { maxPerCategory: 20, staleDays: 45, lowQualityMaxScore: 0.2, lowAccessMax: 1 };
const JUNK_TYPES = new Set(['episodic', 'conversation', 'workspace', 'repo', 'procedural']);

export class MemoryGovernanceReportBuilder {
  constructor(private readonly database: Database) {}

  async build(config: GovernanceReportConfig = {}): Promise<GovernanceReport> {
    const rules = { ...DEFAULTS, ...config };
    const rows = await this.loadRows(config.projectId);
    const active = rows.filter((row) => row.superseded_by == null);
    const categories = this.collectCategories(rows, active, rules);
    return {
      generatedAt: new Date().toISOString(),
      projectId: config.projectId ?? null,
      scannedTotal: rows.length,
      activeMemories: active.length,
      scoredActive: active.filter((row) => row.quality_score != null).length,
      supersededMemories: rows.length - active.length,
      categoryCounts: mapCounts(categories),
      categories,
    };
  }

  private async loadRows(projectId?: string): Promise<MemoryRow[]> {
    const pool = this.database.getPool();
    const params: unknown[] = [projectId ?? null];
    const result = await pool.query(
      `SELECT m.id, m.memory_type, m.content, m.created_at, COALESCE(m.last_accessed_at, m.accessed_at) AS accessed_at,
              COALESCE(m.access_count, 0) AS access_count, m.superseded_by,
              mq.score::float AS quality_score, mq.band AS quality_band,
              COALESCE(r.recall_count, 0)::int AS recall_count
       FROM memories m
       LEFT JOIN memory_quality_scores mq ON mq.memory_id = m.id
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS recall_count FROM memory_recall_events WHERE memory_id = m.id
       ) r ON true
       WHERE ($1::text IS NULL OR m.project_id = $1)
       ORDER BY m.created_at ASC`,
      params,
    );
    return result.rows as MemoryRow[];
  }

  private collectCategories(rows: MemoryRow[], active: MemoryRow[], rules: GovernanceRules) {
    return {
      lowQuality: bucket(filterLowQuality(active, rules.lowQualityMaxScore), rules.maxPerCategory, 'low score band'),
      stale: bucket(filterStale(active, rules.staleDays), rules.maxPerCategory, `stale >= ${rules.staleDays}d`),
      lowAccess: bucket(filterLowAccess(active, rules.lowAccessMax), rules.maxPerCategory, `low access <= ${rules.lowAccessMax}`),
      supersededDuplicates: bucket(rows.filter((row) => row.superseded_by != null), rules.maxPerCategory, 'already superseded'),
      typeSpecificJunk: bucket(filterTypeSpecificJunk(active, rules), rules.maxPerCategory, 'type-specific junk heuristic'),
    };
  }
}

function filterLowQuality(rows: MemoryRow[], maxScore: number) {
  return rows.filter((row) => row.quality_score != null && row.quality_score <= maxScore);
}

function filterStale(rows: MemoryRow[], staleDays: number) {
  return rows.filter((row) => ageDays(row.created_at) >= staleDays && ageDays(row.accessed_at ?? row.created_at) >= staleDays / 2 && row.recall_count === 0);
}

function filterLowAccess(rows: MemoryRow[], lowAccessMax: number) {
  return rows.filter((row) => ageDays(row.created_at) >= 14 && row.access_count <= lowAccessMax && row.recall_count === 0);
}

function filterTypeSpecificJunk(rows: MemoryRow[], rules: GovernanceRules) {
  return rows.filter((row) => JUNK_TYPES.has(row.memory_type) && row.content.length < 120 && ageDays(row.created_at) >= 14 && row.access_count <= rules.lowAccessMax && row.recall_count === 0 && (row.quality_score ?? 0.3) <= 0.4);
}

function bucket(rows: MemoryRow[], maxPerCategory: number, label: string): GovernanceBucket {
  const sorted = [...rows].sort(compareRows);
  return {
    count: rows.length,
    byType: countByType(rows),
    samples: sorted.slice(0, maxPerCategory).map((row) => toCandidate(row, label)),
  };
}

function compareRows(a: MemoryRow, b: MemoryRow): number {
  if ((a.quality_score ?? 1) !== (b.quality_score ?? 1)) return (a.quality_score ?? 1) - (b.quality_score ?? 1);
  if (a.access_count !== b.access_count) return a.access_count - b.access_count;
  return b.created_at.getTime() - a.created_at.getTime();
}

function toCandidate(row: MemoryRow, reason: string): GovernanceCandidate {
  return {
    memoryId: Number(row.id),
    memoryType: row.memory_type,
    reason,
    score: row.quality_score,
    band: row.quality_band,
    ageDays: Math.round(ageDays(row.created_at)),
    accessCount: row.access_count,
    recallCount: row.recall_count,
    snippet: row.content.replace(/\s+/g, ' ').slice(0, 120),
    supersededBy: row.superseded_by == null ? null : Number(row.superseded_by),
  };
}

function countByType(rows: MemoryRow[]) {
  return rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.memory_type] = (acc[row.memory_type] || 0) + 1;
    return acc;
  }, {});
}

function mapCounts(categories: Record<CandidateKind, GovernanceBucket>) {
  return {
    lowQuality: categories.lowQuality.count,
    stale: categories.stale.count,
    lowAccess: categories.lowAccess.count,
    supersededDuplicates: categories.supersededDuplicates.count,
    typeSpecificJunk: categories.typeSpecificJunk.count,
  };
}

function ageDays(value: Date) {
  return Math.max(0, (Date.now() - new Date(value).getTime()) / 86_400_000);
}

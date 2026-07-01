import type { Database } from './database.js';

export type ArchiveReasonCode = 'already_superseded_duplicate' | 'tiny_type_specific_junk';

export interface ArchiveCandidateReportConfig {
  projectId?: string;
  maxPerReason?: number;
}

export interface ArchiveCandidate {
  memoryId: number;
  memoryType: string;
  reasonCode: ArchiveReasonCode;
  reason: string;
  score: number | null;
  band: string | null;
  ageDays: number;
  accessCount: number;
  recallCount: number;
  snippet: string;
  supersededBy: number | null;
}

export interface ArchiveBucket {
  count: number;
  byType: Record<string, number>;
  samples: ArchiveCandidate[];
}

export interface ArchiveCandidateReport {
  generatedAt: string;
  projectId: string | null;
  reversibilityNote: string;
  scannedTotal: number;
  activeMemories: number;
  candidateCount: number;
  overlapCount: number;
  excludedCounts: {
    lowAccess: number;
    mediumBandConversation: number;
  };
  reasonCounts: Record<ArchiveReasonCode, number>;
  categories: Record<ArchiveReasonCode, ArchiveBucket>;
}

interface MemoryRow {
  id: number; memory_type: string; content: string; created_at: Date;
  access_count: number; superseded_by: number | null; quality_score: number | null;
  quality_band: string | null; recall_count: number;
}

const MAX_PER_REASON = 20;
const LOW_ACCESS_MAX = 1;
const JUNK_TYPES = new Set(['episodic', 'conversation', 'workspace', 'repo', 'procedural']);

export class ArchiveCandidateReportBuilder {
  constructor(private readonly database: Database) {}

  async build(config: ArchiveCandidateReportConfig = {}): Promise<ArchiveCandidateReport> {
    const rows = await this.loadRows(config.projectId);
    const active = rows.filter((row) => row.superseded_by == null);
    const lowAccess = filterLowAccess(active);
    const junkBase = filterTinyTypeSpecificJunkBase(active);
    const junk = junkBase.filter((row) => !isMediumConversation(row));
    const superseded = rows.filter((row) => row.superseded_by != null);
    const overlapCount = countOverlap(superseded, junk);
    const maxPerReason = config.maxPerReason ?? MAX_PER_REASON;
    const categories = {
      already_superseded_duplicate: bucket(superseded, maxPerReason, 'already superseded duplicate', 'already_superseded_duplicate'),
      tiny_type_specific_junk: bucket(junk, maxPerReason, 'tiny type-specific junk', 'tiny_type_specific_junk'),
    };

    return {
      generatedAt: new Date().toISOString(),
      projectId: config.projectId ?? null,
      reversibilityNote: 'Candidates only. No archive, prune, delete, or recall change was performed.',
      scannedTotal: rows.length,
      activeMemories: active.length,
      candidateCount: countDistinctIds([...superseded, ...junk]),
      overlapCount,
      excludedCounts: {
        lowAccess: lowAccess.length,
        mediumBandConversation: junkBase.filter(isMediumConversation).length,
      },
      reasonCounts: mapCounts(categories),
      categories,
    };
  }

  private async loadRows(projectId?: string): Promise<MemoryRow[]> {
    const pool = this.database.getPool();
    const params: unknown[] = [projectId ?? null];
    const result = await pool.query(
      `SELECT m.id, m.memory_type, m.content, m.created_at,
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
}

function filterLowAccess(rows: MemoryRow[]) {
  return rows.filter((row) => ageDays(row.created_at) >= 14 && row.access_count <= LOW_ACCESS_MAX && row.recall_count === 0);
}

function filterTinyTypeSpecificJunkBase(rows: MemoryRow[]) {
  return rows.filter((row) => (
    JUNK_TYPES.has(row.memory_type)
    && row.content.length < 120
    && ageDays(row.created_at) >= 14
    && row.access_count <= LOW_ACCESS_MAX
    && row.recall_count === 0
    && (row.quality_score ?? 0.3) <= 0.4
  ));
}

function isMediumConversation(row: MemoryRow) {
  return row.memory_type === 'conversation' && row.quality_band === 'medium';
}

function countOverlap(first: MemoryRow[], second: MemoryRow[]) {
  const secondIds = new Set(second.map((row) => row.id));
  return first.reduce((total, row) => total + (secondIds.has(row.id) ? 1 : 0), 0);
}

function countDistinctIds(rows: MemoryRow[]) {
  return new Set(rows.map((row) => row.id)).size;
}

function bucket(rows: MemoryRow[], maxPerReason: number, reason: string, reasonCode: ArchiveReasonCode): ArchiveBucket {
  const sorted = [...rows].sort(compareRows);
  return {
    count: rows.length,
    byType: countByType(rows),
    samples: sorted.slice(0, maxPerReason).map((row) => toCandidate(row, reason, reasonCode)),
  };
}

function compareRows(a: MemoryRow, b: MemoryRow) {
  if ((a.quality_score ?? 1) !== (b.quality_score ?? 1)) return (a.quality_score ?? 1) - (b.quality_score ?? 1);
  if (a.access_count !== b.access_count) return a.access_count - b.access_count;
  return b.created_at.getTime() - a.created_at.getTime();
}

function toCandidate(row: MemoryRow, reason: string, reasonCode: ArchiveReasonCode): ArchiveCandidate {
  return {
    memoryId: Number(row.id),
    memoryType: row.memory_type,
    reasonCode,
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

function mapCounts(categories: Record<ArchiveReasonCode, ArchiveBucket>) {
  return {
    already_superseded_duplicate: categories.already_superseded_duplicate.count,
    tiny_type_specific_junk: categories.tiny_type_specific_junk.count,
  };
}

function ageDays(value: Date) {
  return Math.max(0, (Date.now() - new Date(value).getTime()) / 86_400_000);
}

import type { DatabasePool } from './types.js';
import { dialectFromPool, isUniqueViolation, toDate, type QueryDialect } from './db/query-dialect.js';
import { getLogger } from './logger.js';
import { BELIEF_CANDIDATE_TYPES, type BeliefCandidateType } from './candidate-schema.js';

export type { BeliefCandidateType };
export { BELIEF_CANDIDATE_TYPES };

export interface BeliefScanConfig {
  dryRun?: boolean;
  types?: BeliefCandidateType[];
  maxPerType?: number;
  lookbackMinutes?: number;
  minPacketCount?: number;
  minReinforcement?: number;
  projectId?: string;
}

export interface BeliefCandidateRow {
  id?: number;
  candidateType: BeliefCandidateType;
  dedupKey: string;
  reason: string;
  confidence: number;
  eventCount: number;
  reinforcementCount: number;
  contradictedCount: number;
  lastReinforcedAt: Date;
  sourcePacketIds: number[];
  metadata: Record<string, unknown>;
  promotionReady: boolean;
  status: string;
}

export interface BeliefScanReport {
  dryRun: boolean;
  candidates: BeliefCandidateRow[];
  inserted: number;
  updated: number;
  skippedDuplicates: number;
  byType: Record<string, number>;
  packetsScanned: number;
  patternsFound: number;
}

interface PacketRow {
  id: number;
  session_id: string;
  project_id: string | null;
  entry_type: string;
  signals: string | Record<string, unknown>;
  created_at: string | Date;
}

interface PatternGroup {
  candidateType: BeliefCandidateType;
  dedupKey: string;
  packetIds: number[];
  eventCount: number;
  reinforcementCount: number;
  contradictedCount: number;
  lastReinforcedAt: Date;
  reason: string;
  metadata: Record<string, unknown>;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function categorizeIntent(intent: string): string {
  const lower = intent.toLowerCase();
  if (/complete|done|finish|pass|success|achieved/i.test(lower)) return 'completion';
  if (/fix|bug|error|issue|repair|resolve/i.test(lower)) return 'fix';
  if (/test|verify|check|assert|validate/i.test(lower)) return 'verification';
  if (/refactor|clean|improve|simplify|restructure/i.test(lower)) return 'refinement';
  if (/add|create|implement|build|introduce|setup/i.test(lower)) return 'creation';
  if (/learn|explore|search|find|investigate|research/i.test(lower)) return 'exploration';
  return 'other';
}

function normalizeError(error: string): string {
  return error.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
}

export class BeliefPromotionScanner {
  private readonly pool: DatabasePool;

  /**
   * Phase 5A: gate pattern emission by reinforcement count.
   * Milestones must recur >= 3x in the same category before generating a
   * `candidate_worldview`. Other candidate types default to 1 (one-shot ok).
   * Constraint 3: milestones are evidence first; only worldview candidates
   * after recurring patterns.
   */
  private static readonly MIN_EMIT: Partial<Record<BeliefCandidateType, number>> = {
    candidate_worldview: 3,
    candidate_drift_warning: 0,
    candidate_belief: 0,
    candidate_preference: 0,
    candidate_opinion: 0,
    candidate_capability: 5,
  };

  constructor(pool: DatabasePool) {
    this.pool = pool;
  }

  async scan(config: BeliefScanConfig = {}): Promise<BeliefScanReport> {
    const d = dialectFromPool(this.pool as { getDialect?: () => QueryDialect });
    const dryRun = config.dryRun ?? true;
    const maxPerType = config.maxPerType ?? 20;
    const lookbackMinutes = config.lookbackMinutes ?? 1440;
    const minPacketCount = config.minPacketCount ?? 2;
    const allowedTypes = config.types ?? [...BELIEF_CANDIDATE_TYPES];

    const lookbackDate = new Date(Date.now() - lookbackMinutes * 60 * 1000);

    const params: unknown[] = [lookbackDate.toISOString()];
    let projectClause = '';
    if (config.projectId) {
      params.push(config.projectId);
      projectClause = ` AND project_id = $${params.length}`;
    }

    const sql = `
      SELECT id, session_id, project_id, entry_type, signals, created_at
      FROM experience_packets
      WHERE created_at >= $1
      ${projectClause}
      ORDER BY created_at ASC
    `;

    const result = await this.pool.query(sql, params);
    const packets = result.rows as PacketRow[];
    const patternGroups = this.groupPatterns(packets, allowedTypes);

    const byType: Record<string, number> = {};
    for (const g of patternGroups) {
      byType[g.candidateType] = (byType[g.candidateType] ?? 0) + 1;
    }

    if (dryRun) {
      return {
        dryRun: true,
        candidates: patternGroups
          .filter(g => g.eventCount >= minPacketCount)
          .filter(g => {
            if (config.minReinforcement !== undefined) return true;
            const min = BeliefPromotionScanner.MIN_EMIT[g.candidateType] ?? 1;
            return g.reinforcementCount >= min;
          })
          .map(g => this.toCandidateRow(g)),
        inserted: 0,
        updated: 0,
        skippedDuplicates: 0,
        byType,
        packetsScanned: packets.length,
        patternsFound: patternGroups.length,
      };
    }

    let inserted = 0;
    let updated = 0;
    let skippedDuplicates = 0;
    const candidates: BeliefCandidateRow[] = [];
    const actualByType: Record<string, number> = {};

    const worthyGroups = patternGroups
      .filter(g => g.eventCount >= minPacketCount)
      .filter(g => {
        if (config.minReinforcement !== undefined) return true;
        const min = BeliefPromotionScanner.MIN_EMIT[g.candidateType] ?? 1;
        return g.reinforcementCount >= min;
      });

    const typeCounts: Record<string, number> = {};
    for (const g of worthyGroups) {
      const current = typeCounts[g.candidateType] ?? 0;
      if (current >= maxPerType) {
        skippedDuplicates++;
        continue;
      }
      typeCounts[g.candidateType] = current + 1;
      actualByType[g.candidateType] = (actualByType[g.candidateType] ?? 0) + 1;

      const row = this.toCandidateRow(g);
      const result_ = await this.upsertCandidate(row, d);
      if (result_ === 'inserted') inserted++;
      else if (result_ === 'updated') updated++;
      else skippedDuplicates++;
      candidates.push(row);
    }

    getLogger().info(
      `Belief scan: ${packets.length} packets, ${patternGroups.length} patterns, ${inserted} inserted, ${updated} updated`,
    );

    return {
      dryRun: false,
      candidates,
      inserted,
      updated,
      skippedDuplicates,
      byType: actualByType,
      packetsScanned: packets.length,
      patternsFound: patternGroups.length,
    };
  }

  async report(): Promise<{ byType: Record<string, number>; byStatus: Record<string, number>; total: number }> {
    const result = await this.pool.query(
      `SELECT candidate_type, status, COUNT(*) AS count
       FROM memory_candidate_queue
       WHERE candidate_type IN ('candidate_belief', 'candidate_preference', 'candidate_worldview', 'candidate_drift_warning', 'candidate_opinion', 'candidate_capability')
       GROUP BY candidate_type, status
       ORDER BY candidate_type, status`,
    );
    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of result.rows as Array<{ candidate_type: string; status: string; count: number | string }>) {
      const n = typeof row.count === 'number' ? row.count : Number(row.count) || 0;
      total += n;
      byType[row.candidate_type] = (byType[row.candidate_type] ?? 0) + n;
      byStatus[row.status] = (byStatus[row.status] ?? 0) + n;
    }
    return { byType, byStatus, total };
  }

  private groupPatterns(packets: PacketRow[], allowedTypes: BeliefCandidateType[]): PatternGroup[] {
    const groups = new Map<string, PatternGroup>();

    for (const p of packets) {
      const signals = typeof p.signals === 'string' ? JSON.parse(p.signals) : p.signals;
      const entry = this.extractPattern(signals, p.entry_type);
      if (!entry) continue;
      if (!allowedTypes.includes(entry.candidateType)) continue;

      const key = `${entry.candidateType}:${entry.dedupKey}`;
      const existing = groups.get(key);

      if (existing) {
        existing.eventCount++;
        if (entry.isReinforcement) existing.reinforcementCount++;
        if (entry.isContradiction) existing.contradictedCount++;
        existing.packetIds.push(p.id);
        const ts = toDate(dialectFromPool(this.pool as { getDialect?: () => QueryDialect }), p.created_at);
        if (ts > existing.lastReinforcedAt) existing.lastReinforcedAt = ts;
      } else {
        const ts = toDate(dialectFromPool(this.pool as { getDialect?: () => QueryDialect }), p.created_at);
        groups.set(key, {
          candidateType: entry.candidateType,
          dedupKey: entry.dedupKey,
          packetIds: [p.id],
          eventCount: 1,
          reinforcementCount: entry.isReinforcement ? 1 : 0,
          contradictedCount: entry.isContradiction ? 1 : 0,
          lastReinforcedAt: ts,
          reason: entry.reason,
          metadata: {
            patternKey: entry.dedupKey,
            sampleSignals: entry.sampleSignals,
            sessionIds: [p.session_id],
          },
        });
      }
    }

    return [...groups.values()];
  }

  private extractPattern(
    signals: Record<string, unknown>,
    entryType: string,
  ): {
    candidateType: BeliefCandidateType;
    dedupKey: string;
    isReinforcement: boolean;
    isContradiction: boolean;
    reason: string;
    sampleSignals: Record<string, unknown>;
  } | null {
    const toolName = signals.toolName as string | undefined;
    const error = signals.error as string | undefined;
    const exitCode = signals.exitCode as number | undefined;
    const intent = signals.intent as string | undefined;
    const freeTextDecision = signals.freeTextDecision as boolean | undefined;

    switch (entryType) {
      case 'tool_execution': {
        if (!toolName) return null;
        const isError = !!error || (exitCode !== undefined && exitCode !== 0);

        if (isError) {
          return {
            candidateType: 'candidate_belief',
            dedupKey: `tool:${toolName}:fail`,
            isReinforcement: false,
            isContradiction: true,
            reason: `${toolName} fails — ${(error ?? `exit ${exitCode}`).slice(0, 60)}`,
            sampleSignals: { toolName, outcome: 'fail' },
          };
        }

        if (freeTextDecision) {
          return {
            candidateType: 'candidate_preference',
            dedupKey: `pref:freetext:${toolName}`,
            isReinforcement: true,
            isContradiction: false,
            reason: `User free-text decision via ${toolName}`,
            sampleSignals: { toolName, source: 'freeTextDecision' },
          };
        }

        if (toolName === 'question') {
          return {
            candidateType: 'candidate_preference',
            dedupKey: `pref:question:${toolName}`,
            isReinforcement: true,
            isContradiction: false,
            reason: 'User answered question (free-text commitment)',
            sampleSignals: { toolName, source: 'questionAnswer' },
          };
        }

        if (toolName.startsWith('csm_')) {
          return null;
        }

        return null;
      }

      case 'error': {
        if (!toolName || !error) return null;
        const errorStem = normalizeError(error);
        const dedupKey = `err:${toolName}:${errorStem}`;
        return {
          candidateType: 'candidate_belief',
          dedupKey,
          isReinforcement: false,
          isContradiction: true,
          reason: `${toolName} error: ${error.slice(0, 80)}`,
          sampleSignals: { toolName, errorStem },
        };
      }

      case 'milestone': {
        if (!intent) return null;
        const cat = categorizeIntent(intent);
        const dedupKey = `ms:${cat}`;
        return {
          candidateType: 'candidate_worldview',
          dedupKey,
          isReinforcement: true,
          isContradiction: false,
          reason: `Milestone category: ${cat}`,
          sampleSignals: { category: cat },
        };
      }

      case 'decision': {
        if (!intent) return null;
        const cat = categorizeIntent(intent);
        const dedupKey = `pref:decision:${cat}`;
        return {
          candidateType: 'candidate_preference',
          dedupKey,
          isReinforcement: true,
          isContradiction: false,
          reason: `User decision — category: ${cat}`,
          sampleSignals: { category: cat },
        };
      }

      case 'loop_signal': {
        if (!toolName) return null;
        const dedupKey = `loop:${toolName}`;
        return {
          candidateType: 'candidate_drift_warning',
          dedupKey,
          isReinforcement: false,
          isContradiction: true,
          reason: `Loop detected on ${toolName}`,
          sampleSignals: { toolName },
        };
      }

      default:
        return null;
    }
  }

  private computeConfidence(eventCount: number, contradictedCount: number): number {
    if (eventCount === 0) return 0;
    let base: number;
    if (eventCount <= 1) base = 0.1;
    else base = Math.min(0.3 + (eventCount - 2) * 0.1, 0.95);

    if (contradictedCount > 0) {
      base = base * (0.5 / (contradictedCount + 0.5));
    }
    return clamp01(base);
  }

  private toCandidateRow(g: PatternGroup): BeliefCandidateRow {
    const confidence = this.computeConfidence(g.eventCount, g.contradictedCount);

    return {
      candidateType: g.candidateType,
      dedupKey: g.dedupKey,
      reason: `${g.reason} (${g.eventCount}x, ${g.reinforcementCount}R/${g.contradictedCount}C)`,
      confidence,
      eventCount: g.eventCount,
      reinforcementCount: g.reinforcementCount,
      contradictedCount: g.contradictedCount,
      lastReinforcedAt: g.lastReinforcedAt,
      sourcePacketIds: g.packetIds,
      metadata: g.metadata,
      promotionReady: confidence >= 0.7,
      status: 'pending',
    };
  }

  private async upsertCandidate(row: BeliefCandidateRow, d: QueryDialect): Promise<'inserted' | 'updated' | 'skipped'> {
    const sourcePacketIdsJson = JSON.stringify(row.sourcePacketIds);
    const lastReinforcedStr = row.lastReinforcedAt instanceof Date
      ? row.lastReinforcedAt.toISOString()
      : new Date().toISOString();
    const nowStr = new Date().toISOString();

    const cols = `(candidate_type, memory_id, dedup_key, reason, confidence,
      event_count, reinforcement_count, contradicted_count, last_reinforced_at,
      source_packet_ids, source_signals, promotion_ready, status, created_at, updated_at)`;

    const vals = `($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, '{}', $10, $11, $12, $13)`;

    const updateSet = d === 'sqlite'
      ? `event_count = excluded.event_count,
         reinforcement_count = excluded.reinforcement_count,
         contradicted_count = excluded.contradicted_count,
         last_reinforced_at = excluded.last_reinforced_at,
         source_packet_ids = excluded.source_packet_ids,
         confidence = excluded.confidence,
         reason = excluded.reason,
         promotion_ready = excluded.promotion_ready,
         updated_at = excluded.updated_at`
      : `event_count = EXCLUDED.event_count,
         reinforcement_count = EXCLUDED.reinforcement_count,
         contradicted_count = EXCLUDED.contradicted_count,
         last_reinforced_at = EXCLUDED.last_reinforced_at,
         source_packet_ids = EXCLUDED.source_packet_ids,
         confidence = EXCLUDED.confidence,
         reason = EXCLUDED.reason,
         promotion_ready = EXCLUDED.promotion_ready,
         updated_at = now()`;

    try {
      await this.pool.query(
        `INSERT INTO memory_candidate_queue ${cols} VALUES ${vals}
         ON CONFLICT(candidate_type, dedup_key) WHERE dedup_key IS NOT NULL AND status = 'pending' DO UPDATE SET ${updateSet}`,
        [
          row.candidateType,
          row.dedupKey,
          row.reason,
          row.confidence,
          row.eventCount,
          row.reinforcementCount,
          row.contradictedCount,
          lastReinforcedStr,
          sourcePacketIdsJson,
          row.promotionReady,
          row.status,
          nowStr,
          nowStr,
        ],
      );
      return 'inserted';
    } catch (error) {
      if (isUniqueViolation(d, error)) return 'skipped';
      throw error;
    }
  }
}

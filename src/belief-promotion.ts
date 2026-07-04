import type { DatabasePool, MemoryType } from './types.js';
import { dialectFromPool, type QueryDialect } from './db/query-dialect.js';
import { getLogger } from './logger.js';
import { BELIEF_CANDIDATE_TYPES, type BeliefCandidateType } from './candidate-schema.js';

export interface PromotionConfig {
  dryRun?: boolean;
  relaxed?: boolean;
  minConfidence?: number;
  minReinforcement?: number;
  minEvidenceRefs?: number;
  minSessions?: number;
  maxPromote?: number;
  projectId?: string;
}

export interface PromotionCandidate {
  id: number;
  candidateType: BeliefCandidateType;
  dedupKey: string;
  reason: string;
  confidence: number;
  eventCount: number;
  reinforcementCount: number;
  contradictedCount: number;
  sourcePacketIds: number[];
  promotionReady: boolean;
}

export interface PromotionDecision {
  candidateId: number;
  candidateType: BeliefCandidateType;
  dedupKey: string;
  reason: string;
  confidence: number;
  action: 'promote' | 'skip_low_confidence' | 'skip_low_reinforcement' | 'skip_low_evidence' | 'skip_low_session_diversity' | 'skip_contradicted' | 'needs_review' | 'skip_dedup_match';
  targetMemoryType: MemoryType;
  dedupMatchId?: number;
  dedupMatchContent?: string;
  evidenceSessions?: number;
  thresholdChecks: {
    confidence: { passed: boolean; actual: number; required: number };
    reinforcement: { passed: boolean; actual: number; required: number };
    evidence: { passed: boolean; actual: number; required: number };
    sessions: { passed: boolean; actual: number; required: number };
    contradicted: { passed: boolean; actual: number };
  };
}

export interface PromotionReport {
  dryRun: boolean;
  relaxed: boolean;
  thresholdProfile: {
    minConfidence: number;
    minReinforcement: number;
    minEvidenceRefs: number;
    minSessions: number;
  };
  candidatesEvaluated: number;
  promoted: number;
  skipped: number;
  needsReview: number;
  decisions: PromotionDecision[];
  promotedMemoryIds: number[];
  byAction: Record<string, number>;
}

function candidateTypeToMemoryType(ct: BeliefCandidateType): MemoryType {
  switch (ct) {
    case 'candidate_belief': return 'preference';
    case 'candidate_preference': return 'preference';
    case 'candidate_worldview': return 'repo';
    case 'candidate_opinion': return 'conversation';
    case 'candidate_drift_warning': return 'lesson';
    default: return 'preference';
  }
}

export class BeliefPromotionEngine {
  private readonly pool: DatabasePool;
  private readonly log = getLogger();

  constructor(pool: DatabasePool) {
    this.pool = pool;
  }

  async promote(config: PromotionConfig = {}): Promise<PromotionReport> {
    const d = dialectFromPool(this.pool as { getDialect?: () => QueryDialect });
    const dryRun = config.dryRun ?? true;
    const relaxed = config.relaxed ?? false;
    const minConfidence = config.minConfidence ?? (relaxed ? 0.3 : 0.7);
    const minReinforcement = config.minReinforcement ?? (relaxed ? 1 : 3);
    const minEvidenceRefs = config.minEvidenceRefs ?? (relaxed ? 1 : 2);
    const minSessions = config.minSessions ?? 1;
    const maxPromote = config.maxPromote ?? 10;

    const candidates = await this.loadPendingCandidates(d);
    const decisions: PromotionDecision[] = [];
    const promotedMemoryIds: number[] = [];
    let promoteCount = 0;

    for (const c of candidates) {
      if (promoteCount >= maxPromote) break;

      const decision = await this.evaluateCandidate(c, {
        minConfidence,
        minReinforcement,
        minEvidenceRefs,
        minSessions,
        d,
      });

      decisions.push(decision);

      if (decision.action === 'promote' && !dryRun) {
        const memoryId = await this.createMemoryFromCandidate(c, decision, d);
        if (memoryId) {
          promotedMemoryIds.push(memoryId);
          await this.markCandidateApplied(c.id, d);
          promoteCount++;
        }
      } else if (decision.action === 'promote' && dryRun) {
        promoteCount++;
      }
    }

    const byAction: Record<string, number> = {};
    for (const dec of decisions) {
      byAction[dec.action] = (byAction[dec.action] ?? 0) + 1;
    }

    this.log.info(`Belief promotion: ${promoteCount} promoted, ${decisions.length - promoteCount} skipped, dryRun=${dryRun}, relaxed=${relaxed}`);

    return {
      dryRun,
      relaxed,
      thresholdProfile: {
        minConfidence,
        minReinforcement,
        minEvidenceRefs,
        minSessions,
      },
      candidatesEvaluated: candidates.length,
      promoted: promoteCount,
      skipped: decisions.length - promoteCount,
      needsReview: byAction['needs_review'] ?? 0,
      decisions,
      promotedMemoryIds,
      byAction,
    };
  }

  private async loadPendingCandidates(_d: QueryDialect): Promise<PromotionCandidate[]> {
    const typeList = BELIEF_CANDIDATE_TYPES.map(t => `'${t}'`).join(', ');
    const result = await this.pool.query(
      `SELECT id, candidate_type, dedup_key, reason, confidence, event_count,
              reinforcement_count, contradicted_count, source_packet_ids, promotion_ready
       FROM memory_candidate_queue
       WHERE candidate_type IN (${typeList})
         AND status = 'pending'
       ORDER BY confidence DESC, reinforcement_count DESC`,
    );

    return (result.rows as Array<{
      id: number; candidate_type: string; dedup_key: string; reason: string;
      confidence: number; event_count: number; reinforcement_count: number;
      contradicted_count: number; source_packet_ids: unknown; promotion_ready: boolean;
    }>).map(r => ({
      id: r.id,
      candidateType: r.candidate_type as BeliefCandidateType,
      dedupKey: r.dedup_key,
      reason: r.reason,
      confidence: r.confidence,
      eventCount: r.event_count,
      reinforcementCount: r.reinforcement_count,
      contradictedCount: r.contradicted_count,
      sourcePacketIds: Array.isArray(r.source_packet_ids) ? r.source_packet_ids as number[] : JSON.parse(r.source_packet_ids as string ?? '[]'),
      promotionReady: r.promotion_ready,
    }));
  }

  private async evaluateCandidate(
    c: PromotionCandidate,
    opts: {
      minConfidence: number;
      minReinforcement: number;
      minEvidenceRefs: number;
      minSessions: number;
      d: QueryDialect;
    },
  ): Promise<PromotionDecision> {
    const targetMemoryType = candidateTypeToMemoryType(c.candidateType);
    const sessionCount = await this.countDistinctSessions(c.sourcePacketIds, opts.d);

    const thresholdChecks = {
      confidence: { passed: c.confidence >= opts.minConfidence, actual: c.confidence, required: opts.minConfidence },
      reinforcement: { passed: c.reinforcementCount >= opts.minReinforcement, actual: c.reinforcementCount, required: opts.minReinforcement },
      evidence: { passed: c.sourcePacketIds.length >= opts.minEvidenceRefs, actual: c.sourcePacketIds.length, required: opts.minEvidenceRefs },
      sessions: { passed: sessionCount >= opts.minSessions, actual: sessionCount, required: opts.minSessions },
      contradicted: { passed: c.contradictedCount === 0, actual: c.contradictedCount },
    };

    // Rule: skip low confidence
    if (c.confidence < opts.minConfidence) {
      return this.decision(c, 'skip_low_confidence', targetMemoryType, undefined, thresholdChecks);
    }

    // Rule: skip low reinforcement
    if (c.reinforcementCount < opts.minReinforcement) {
      return this.decision(c, 'skip_low_reinforcement', targetMemoryType, undefined, thresholdChecks);
    }

    // Rule: skip contradicted candidates
    if (c.contradictedCount > 0) {
      return this.decision(c, 'needs_review', targetMemoryType, undefined, thresholdChecks);
    }

    // Rule: check evidence ref count
    if (c.sourcePacketIds.length < opts.minEvidenceRefs) {
      return this.decision(c, 'skip_low_evidence', targetMemoryType, undefined, thresholdChecks);
    }

    // Rule: check session diversity
    if (sessionCount < opts.minSessions) {
      return this.decision(c, 'skip_low_session_diversity', targetMemoryType, undefined, thresholdChecks);
    }

    // Rule: dedup against existing memories
    const dedupMatch = await this.findDuplicate(c.reason, targetMemoryType, opts.d);
    if (dedupMatch) {
      return {
        ...this.decision(c, 'skip_dedup_match', targetMemoryType, sessionCount, thresholdChecks),
        dedupMatchId: dedupMatch.id,
        dedupMatchContent: dedupMatch.content,
      };
    }

    // Passed all gates
    return this.decision(c, 'promote', targetMemoryType, sessionCount, thresholdChecks);
  }

  private decision(
    c: PromotionCandidate,
    action: PromotionDecision['action'],
    targetMemoryType: MemoryType,
    evidenceSessions?: number,
    thresholdChecks?: PromotionDecision['thresholdChecks'],
  ): PromotionDecision {
    return {
      candidateId: c.id,
      candidateType: c.candidateType,
      dedupKey: c.dedupKey,
      reason: c.reason,
      confidence: c.confidence,
      action,
      targetMemoryType,
      evidenceSessions,
      thresholdChecks: thresholdChecks ?? {
        confidence: { passed: false, actual: c.confidence, required: 0 },
        reinforcement: { passed: false, actual: c.reinforcementCount, required: 0 },
        evidence: { passed: false, actual: c.sourcePacketIds.length, required: 0 },
        sessions: { passed: false, actual: 0, required: 0 },
        contradicted: { passed: false, actual: c.contradictedCount },
      },
    };
  }

  private async countDistinctSessions(packetIds: number[], _d: QueryDialect): Promise<number> {
    if (packetIds.length === 0) return 0;
    const placeholders = packetIds.map((_, i) => `$${i + 1}`).join(',');
    const result = await this.pool.query(
      `SELECT COUNT(DISTINCT session_id) AS session_count
       FROM experience_packets
       WHERE id IN (${placeholders})`,
      packetIds,
    );
    const row = result.rows[0] as { session_count: number | string };
    return typeof row.session_count === 'string' ? parseInt(row.session_count, 10) : row.session_count;
  }

  private async findDuplicate(
    reason: string,
    memoryType: MemoryType,
    _d: QueryDialect,
  ): Promise<{ id: number; content: string } | null> {
    // Search for memories with similar content (first 100 chars of reason)
    const prefix = reason.slice(0, 100).replace(/'/g, "''");
    const result = await this.pool.query(
      `SELECT id, content FROM memories
       WHERE memory_type = $1
         AND LOWER(content) LIKE LOWER($2)
       LIMIT 1`,
      [memoryType, `%${prefix}%`],
    );
    if (result.rows.length > 0) {
      const row = result.rows[0] as { id: number; content: string };
      return { id: row.id, content: row.content.slice(0, 200) };
    }
    return null;
  }

  private async createMemoryFromCandidate(
    c: PromotionCandidate,
    decision: PromotionDecision,
    _d: QueryDialect,
  ): Promise<number | null> {
    const importance = Math.min(1.0, c.confidence * 0.8 + (c.reinforcementCount / 10) * 0.2);
    const content = `[Promoted from candidate ${c.id}] ${c.reason}`;
    const metadata = JSON.stringify({
      promotion_source: 'belief_promotion_engine',
      candidate_id: c.id,
      candidate_type: c.candidateType,
      dedup_key: c.dedupKey,
      source_packet_ids: c.sourcePacketIds,
      evidence_sessions: decision.evidenceSessions,
      confidence: c.confidence,
      reinforcement_count: c.reinforcementCount,
      event_count: c.eventCount,
      promoted_at: new Date().toISOString(),
    });

    const result = await this.pool.query(
      `INSERT INTO memories (memory_type, content, importance, confidence, source, tags, metadata, session_id)
       VALUES ($1, $2, $3, $4, 'belief_promotion', $5::text[], $6, NULL)
       RETURNING id`,
      [
        decision.targetMemoryType,
        content,
        importance,
        c.confidence,
        [c.candidateType, 'auto-promoted'],
        metadata,
      ],
    );

    const row = result.rows[0] as { id: number } | undefined;
    return row?.id ?? null;
  }

  private async markCandidateApplied(candidateId: number, _d: QueryDialect): Promise<void> {
    await this.pool.query(
      `UPDATE memory_candidate_queue
       SET status = 'applied', updated_at = now()
       WHERE id = $1`,
      [candidateId],
    );
  }
}

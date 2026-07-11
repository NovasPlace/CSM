import type { DatabasePool, MemoryType, BeliefPromotionConfig } from './types.js';
import { CAPABILITY_PROVENANCE_TAG, canonicalCapabilityKey } from './types.js';
import { dialectFromPool, jsonExtractText, nowFn, type QueryDialect } from './db/query-dialect.js';
import { getLogger } from './logger.js';
import { BELIEF_CANDIDATE_TYPES, type BeliefCandidateType } from './candidate-schema.js';
import type { MemoryManager } from './memory-manager.js';

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
    case 'candidate_capability': return 'workspace';
    default: return 'preference';
  }
}

function extractToolNameFromDedupKey(dedupKey: string): string | null {
  const match = dedupKey.match(/^cap:(.+):ok$/);
  return match ? match[1] : null;
}

export class BeliefPromotionEngine {
  private readonly pool: DatabasePool;
  private readonly memoryManager: MemoryManager;
  private readonly config: BeliefPromotionConfig;
  private readonly log = getLogger();

  constructor(pool: DatabasePool, memoryManager: MemoryManager, config: BeliefPromotionConfig) {
    this.pool = pool;
    this.memoryManager = memoryManager;
    this.config = config;
  }

  async promote(config: PromotionConfig = {}): Promise<PromotionReport> {
    if (!this.config.enabled) {
      this.log.warn('Belief promotion is disabled (CSM_BELIEF_PROMOTION_ENABLED=false). Skipping.');
      return this.emptyReport(true);
    }

    const d = dialectFromPool(this.pool as { getDialect?: () => QueryDialect });
    const dryRun = config.dryRun ?? this.config.dryRunByDefault;
    const relaxed = config.relaxed ?? this.config.relaxed;
    const minConfidence = config.minConfidence ?? (relaxed ? 0.3 : this.config.minConfidence);
    const minReinforcement = config.minReinforcement ?? (relaxed ? 1 : this.config.minReinforcement);
    const minEvidenceRefs = config.minEvidenceRefs ?? (relaxed ? 1 : this.config.minEvidenceRefs);
    const minSessions = config.minSessions ?? this.config.minSessions;
    const maxPromote = config.maxPromote ?? this.config.maxPromotePerRun;

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

    // Rule: dedup against existing memories (structural key, not fuzzy content match)
    const dedupMatch = await this.findDuplicate(c.dedupKey, targetMemoryType, opts.d);
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
    dedupKey: string,
    memoryType: MemoryType,
    d: QueryDialect,
  ): Promise<{ id: number; content: string } | null> {
    const metaExpr = jsonExtractText(d, 'metadata', 'dedup_key');
    const result = await this.pool.query(
      `SELECT id, content FROM memories
       WHERE memory_type = $1
         AND ${metaExpr} = $2
       LIMIT 1`,
      [memoryType, dedupKey],
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
    const promotedAt = new Date().toISOString();

    const isCapability = c.candidateType === 'candidate_capability';
    const toolName = isCapability ? extractToolNameFromDedupKey(c.dedupKey) : null;
    const canonicalKey = toolName ? canonicalCapabilityKey(toolName) : null;

    const content = isCapability
      ? `[Capability provenance] Capability for ${canonicalKey ?? c.dedupKey} crossed promotion threshold at ${promotedAt} based on ${c.reinforcementCount} reinforcements across ${decision.evidenceSessions ?? 0} sessions. [Snapshot — self-model holds current live state.]`
      : `[Promoted from candidate ${c.id}] ${c.reason}`;

    const metadata: Record<string, unknown> = {
      promotion_source: 'belief_promotion_engine',
      candidate_id: c.id,
      candidate_type: c.candidateType,
      dedup_key: c.dedupKey,
      source_packet_ids: c.sourcePacketIds,
      evidence_sessions: decision.evidenceSessions,
      confidence: c.confidence,
      reinforcement_count: c.reinforcementCount,
      event_count: c.eventCount,
      promoted_at: promotedAt,
      source_kind: 'belief_promotion',
      evidence_strength: 'derived_pattern',
      source_agent_id: 'csmt',
    };

    if (isCapability) {
      metadata.record_type = 'capability_provenance';
      metadata.canonical_key = canonicalKey;
    }

    const tags = isCapability
      ? [CAPABILITY_PROVENANCE_TAG, 'auto-promoted']
      : [c.candidateType, 'auto-promoted'];

    try {
      const memory = await this.memoryManager.saveMemory({
        content,
        type: decision.targetMemoryType,
        importance,
        confidence: c.confidence,
        source: 'auto',
        tags,
        metadata,
      });
      return memory.id;
    } catch (err) {
      this.log.error(`Failed to save promoted memory for candidate ${c.id}`, err instanceof Error ? err : undefined);
      return null;
    }
  }

  private async markCandidateApplied(candidateId: number, d: QueryDialect): Promise<void> {
    await this.pool.query(
      `UPDATE memory_candidate_queue
       SET status = 'applied', updated_at = ${nowFn(d)}
       WHERE id = $1`,
      [candidateId],
    );
  }

  private emptyReport(dryRun: boolean): PromotionReport {
    return {
      dryRun,
      relaxed: false,
      thresholdProfile: { minConfidence: 0, minReinforcement: 0, minEvidenceRefs: 0, minSessions: 0 },
      candidatesEvaluated: 0,
      promoted: 0,
      skipped: 0,
      needsReview: 0,
      decisions: [],
      promotedMemoryIds: [],
      byAction: {},
    };
  }
}

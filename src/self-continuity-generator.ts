import type { DatabasePool } from './types.js';
import { jsonExtractText, dialectFromPool } from './db/query-dialect.js';
import type {
  SelfContinuityRecord,
  SelfContinuityTriggerType,
  IdentityDrift,
  ContinuityConfidenceInput,
  SimilarityMethod,
} from './self-continuity-types.js';
import { CONTINUITY_CONFIDENCE_WEIGHTS } from './self-continuity-types.js';
import { redact } from './redactor.js';

interface SessionEvidence {
  recalledSessionIds: string[];
  recalledMemoryIds: number[];
  evidenceAnchors: string[];
  goalContinued: boolean;
  alchemistInjected: boolean;
  checkpointResumed: boolean;
  selfObservation: string;
  feltGap?: string;
  syntheticTest?: boolean;
}

export class SelfContinuityGenerator {
  private pool: DatabasePool;
  private sessionId: string;
  private projectId: string | undefined;

  private get syntheticTestExpr(): string {
    return jsonExtractText(dialectFromPool(this.pool), 'metadata', 'synthetic_test');
  }

  constructor(pool: DatabasePool, sessionId: string, projectId?: string) {
    this.pool = pool;
    this.sessionId = sessionId;
    this.projectId = projectId;
  }

  async writeRecord(
    triggerType: SelfContinuityTriggerType,
    evidence: SessionEvidence,
  ): Promise<{ id: number; redacted: boolean }> {
    const recognizedPriorSelf = evidence.recalledSessionIds.length > 0;

    const eligiblePriorSessions = await this.countEligiblePriorSessions();
    const selfAssessmentScore =
      evidence.recalledSessionIds.length / Math.max(eligiblePriorSessions, 1);

    const confidenceInput: ContinuityConfidenceInput = {
      recalledSessionScore: this.calculateRecalledSessionScore(evidence),
      evidenceAnchorScore: this.calculateEvidenceAnchorScore(evidence),
      goalContinuityScore: evidence.goalContinued ? 1.0 : 0.0,
      selfSummarySimilarity: await this.calculateSelfSummarySimilarity(evidence),
      selfAssessmentScore: Math.min(selfAssessmentScore, 1.0),
    };

    const continuityConfidence = this.calculateContinuityConfidence(confidenceInput);
    const identityDrift = await this.calculateIdentityDrift(evidence);
    const similarityMethod = await this.determineSimilarityMethod();

    const rawObservation = evidence.selfObservation;
    const redactionResult = redact(rawObservation);
    const redactedObservation = redactionResult.text ?? rawObservation;

    const rawFeltGap = evidence.feltGap ?? '';
    const feltGapResult = redact(rawFeltGap);
    const redactedFeltGap = (feltGapResult.text ?? rawFeltGap) || undefined;

    const goalState = evidence.goalContinued
      ? { continuedFromPrior: true }
      : { continuedFromPrior: false };

    const result = await this.pool.query(
      `INSERT INTO self_continuity_records (
        session_id, project_id, trigger_type, recognized_prior_self,
        continuity_confidence, felt_gap, self_observation,
        recalled_session_ids, recalled_memory_ids, evidence_anchors,
        goal_state, style_fingerprint, identity_drift,
        redaction_audit, similarity_method, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING id`,
      [
        this.sessionId,
        this.projectId ?? null,
        triggerType,
        recognizedPriorSelf,
        continuityConfidence,
        redactedFeltGap ?? null,
        redactedObservation,
        JSON.stringify(evidence.recalledSessionIds),
        JSON.stringify(evidence.recalledMemoryIds),
        JSON.stringify(evidence.evidenceAnchors),
        JSON.stringify(goalState),
        JSON.stringify({}),
        JSON.stringify(identityDrift),
        JSON.stringify([
          { field: 'self_observation', redacted: redactionResult.text !== rawObservation },
          { field: 'felt_gap', redacted: feltGapResult.text !== rawFeltGap },
        ]),
        similarityMethod,
        JSON.stringify({
          confidenceInput,
          selfAssessmentHeuristic: `${evidence.recalledSessionIds.length}/${eligiblePriorSessions}`,
          synthetic_test: evidence.syntheticTest === true ? true : undefined,
        }),
      ],
    );

    const wasRedacted =
      redactionResult.text !== rawObservation ||
      feltGapResult.text !== rawFeltGap;

    const row = result.rows[0] as { id: number } | undefined;
    return {
      id: row?.id ?? 0,
      redacted: wasRedacted,
    };
  }

  private calculateRecalledSessionScore(evidence: SessionEvidence): number {
    if (evidence.recalledSessionIds.length === 0) return 0;
    if (evidence.recalledSessionIds.length >= 3) return 1.0;
    return evidence.recalledSessionIds.length / 3;
  }

  private calculateEvidenceAnchorScore(evidence: SessionEvidence): number {
    if (evidence.evidenceAnchors.length === 0) return 0;
    if (evidence.evidenceAnchors.length >= 4) return 1.0;
    return evidence.evidenceAnchors.length / 4;
  }

  private async calculateSelfSummarySimilarity(evidence: SessionEvidence): Promise<number> {
    if (!evidence.selfObservation || evidence.selfObservation.trim().length === 0) return 0;
    try {
      const priorRecords = await this.getRecentRecords(1);
      if (priorRecords.length === 0) return 0;

      const priorObservation = (priorRecords[0] as { self_observation?: string }).self_observation ?? '';
      if (priorObservation.trim().length === 0) return 0;

      return this.keywordOverlap(evidence.selfObservation, priorObservation);
    } catch {
      return 0;
    }
  }

  private keywordOverlap(textA: string, textB: string): number {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'to', 'of',
      'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
      'during', 'before', 'after', 'above', 'below', 'between', 'out', 'off',
      'over', 'under', 'again', 'further', 'then', 'once', 'and', 'but', 'or',
      'nor', 'not', 'so', 'yet', 'both', 'either', 'neither', 'each', 'every',
      'all', 'any', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
      'only', 'own', 'same', 'than', 'too', 'very', 'just', 'because', 'it',
      'its', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'him', 'his',
      'she', 'her', 'they', 'them', 'their', 'this', 'that', 'these', 'those',
      'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how',
    ]);

    const tokenize = (text: string): Set<string> => {
      const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 1 && !stopWords.has(w));
      return new Set(words);
    };

    const setA = tokenize(textA);
    const setB = tokenize(textB);

    if (setA.size === 0 || setB.size === 0) return 0;

    let overlap = 0;
    for (const word of setA) {
      if (setB.has(word)) overlap++;
    }

    return overlap / Math.max(setA.size, setB.size);
  }

  async calculateSelfSummarySimilarityEmbedding(
    currentEmbedding: number[],
  ): Promise<{ similarity: number; method: SimilarityMethod }> {
    const priorRecords = await this.getRecentRecords(1);
    if (priorRecords.length === 0) {
      return { similarity: 0, method: 'keyword_fallback' };
    }

    const priorRecord = priorRecords[0] as Record<string, unknown>;
    const priorEmbedding = priorRecord['embedding'] as number[] | null;

    if (!priorEmbedding || !Array.isArray(priorEmbedding) || priorEmbedding.length === 0) {
      return { similarity: 0, method: 'keyword_fallback' };
    }

    const similarity = this.cosineSimilarity(currentEmbedding, priorEmbedding);
    return { similarity, method: 'embedding' };
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dotProduct / denom;
  }

  private calculateContinuityConfidence(input: ContinuityConfidenceInput): number {
    const raw =
      input.recalledSessionScore * CONTINUITY_CONFIDENCE_WEIGHTS.recalledSessionScore +
      input.evidenceAnchorScore * CONTINUITY_CONFIDENCE_WEIGHTS.evidenceAnchorScore +
      input.goalContinuityScore * CONTINUITY_CONFIDENCE_WEIGHTS.goalContinuityScore +
      input.selfSummarySimilarity * CONTINUITY_CONFIDENCE_WEIGHTS.selfSummarySimilarity +
      input.selfAssessmentScore * CONTINUITY_CONFIDENCE_WEIGHTS.selfAssessmentScore;

    return Math.max(0, Math.min(1, raw));
  }

  private async calculateIdentityDrift(evidence: SessionEvidence): Promise<IdentityDrift> {
    const goalDrift: IdentityDrift['goalDrift'] = evidence.goalContinued ? 'low' : 'high';
    const lessonAdoption: IdentityDrift['lessonAdoption'] =
      evidence.alchemistInjected ? 'high' : 'low';

    let priorRecords: Record<string, unknown>[] = [];
    try {
      priorRecords = await this.getRecentRecords(3);
    } catch {
      priorRecords = [];
    }
    let styleDrift: IdentityDrift['styleDrift'] = 'low';
    let confidenceDrift: IdentityDrift['confidenceDrift'] = 'low';

    if (priorRecords.length > 0) {
      const priorDrifts = priorRecords
        .map(r => {
          const drift = (r as Record<string, unknown>).identity_drift as IdentityDrift | null;
          return drift;
        })
        .filter((d): d is IdentityDrift => d !== null && d !== undefined);

      if (priorDrifts.length > 0) {
        const highCount = priorDrifts.filter(d => d.styleDrift === 'high').length;
        styleDrift = highCount > priorDrifts.length / 2 ? 'medium' : 'low';

        const confHigh = priorDrifts.filter(d => d.confidenceDrift === 'high').length;
        confidenceDrift = confHigh > 0 ? 'medium' : 'low';
      }
    }

    let continuityGap: IdentityDrift['continuityGap'] = 'significant_gap';
    if (evidence.recalledSessionIds.length > 0 && evidence.evidenceAnchors.length >= 2) {
      continuityGap = 'summary_without_texture';
    } else if (evidence.recalledSessionIds.length > 0) {
      continuityGap = 'partial_recall';
    } else if (recognizedPriorSelfFromEvidence(evidence)) {
      continuityGap = 'summary_without_texture';
    }

    return {
      goalDrift,
      styleDrift,
      confidenceDrift,
      continuityGap,
      lessonAdoption,
    };
  }

  private async determineSimilarityMethod(): Promise<SimilarityMethod> {
    try {
      const result = await this.pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'self_continuity_records' AND column_name = 'embedding'`,
      );
      return result.rows.length > 0 ? 'embedding' : 'keyword_fallback';
    } catch {
      return 'keyword_fallback';
    }
  }

  private async countEligiblePriorSessions(): Promise<number> {
    try {
      const result = await this.pool.query(
        `SELECT COUNT(DISTINCT session_id) as count
         FROM self_continuity_records
         WHERE session_id != $1 AND project_id = $2
         ORDER BY created_at DESC`,
        [this.sessionId, this.projectId ?? null],
      );
      return (result.rows[0] as { count?: string })?.count
        ? parseInt((result.rows[0] as { count: string }).count, 10)
        : 0;
    } catch {
      return 0;
    }
  }

  async getRecentRecords(limit: number): Promise<Record<string, unknown>[]> {
    try {
      const result = await this.pool.query(
        `SELECT * FROM self_continuity_records
         WHERE (project_id = $1 OR project_id IS NULL)
         AND (${this.syntheticTestExpr} IS NULL OR ${this.syntheticTestExpr} != 'true')
         ORDER BY created_at DESC
         LIMIT $2`,
        [this.projectId ?? null, limit],
      );
      return result.rows as Record<string, unknown>[];
    } catch {
      return [];
    }
  }

  static async recallRecords(
    pool: DatabasePool,
    projectId: string | undefined,
    limit: number = 3,
  ): Promise<SelfContinuityRecord[]> {
    const seen = new Set<number>();
    const results: SelfContinuityRecord[] = [];
    const stExpr = jsonExtractText(dialectFromPool(pool), 'metadata', 'synthetic_test');

    const addRecord = (row: Record<string, unknown>) => {
      const id = row.id as number;
      if (!seen.has(id)) {
        seen.add(id);
        results.push(SelfContinuityGenerator.dbRowToRecord(row));
      }
    };

    const safeQuery = async (sql: string, params: unknown[]): Promise<Record<string, unknown>[]> => {
      try {
        const result = await pool.query(sql, params);
        return result.rows as Record<string, unknown>[];
      } catch {
        return [];
      }
    };

    const recentRows = await safeQuery(
      `SELECT * FROM self_continuity_records
       WHERE (project_id = $1 OR project_id IS NULL)
       AND (${stExpr} IS NULL OR ${stExpr} != 'true')
       ORDER BY created_at DESC
       LIMIT $2`,
      [projectId ?? null, limit],
    );
    if (recentRows.length > 0) addRecord(recentRows[0]);

    const similarRows = await safeQuery(
      `SELECT * FROM self_continuity_records
       WHERE (project_id = $1 OR project_id IS NULL)
       AND (${stExpr} IS NULL OR ${stExpr} != 'true')
       ORDER BY continuity_confidence DESC
       LIMIT $2`,
      [projectId ?? null, limit],
    );
    if (similarRows.length > 0) addRecord(similarRows[0]);

    const driftRows = await safeQuery(
      `SELECT * FROM self_continuity_records
       WHERE (project_id = $1 OR project_id IS NULL)
       AND (${stExpr} IS NULL OR ${stExpr} != 'true')
       AND identity_drift::text != '{}'
       ORDER BY created_at DESC
       LIMIT $2`,
      [projectId ?? null, limit],
    );
    if (driftRows.length > 0) addRecord(driftRows[0]);

    return results.slice(0, limit);
  }

  static dbRowToRecord(row: Record<string, unknown>): SelfContinuityRecord {
    const identityDriftRaw = row.identity_drift;
    let identityDrift: IdentityDrift | undefined;
    if (identityDriftRaw && typeof identityDriftRaw === 'object') {
      identityDrift = identityDriftRaw as IdentityDrift;
    } else if (typeof identityDriftRaw === 'string') {
      try {
        identityDrift = JSON.parse(identityDriftRaw) as IdentityDrift;
      } catch {
        identityDrift = undefined;
      }
    }

    return {
      id: row.id as number,
      sessionId: row.session_id as string,
      projectId: (row.project_id as string) || undefined,
      triggerType: row.trigger_type as SelfContinuityTriggerType,
      recognizedPriorSelf: row.recognized_prior_self as boolean,
      continuityConfidence: row.continuity_confidence as number,
      feltGap: (row.felt_gap as string) || undefined,
      selfObservation: row.self_observation as string,
      recalledSessionIds: parseJsonArray(row.recalled_session_ids),
      recalledMemoryIds: parseJsonArray(row.recalled_memory_ids).map(Number),
      evidenceAnchors: parseJsonArray(row.evidence_anchors),
      goalState: parseJsonObj(row.goal_state),
      styleFingerprint: parseJsonObj(row.style_fingerprint),
      identityDrift,
      redactionAudit: parseJsonArrayAsObjects(row.redaction_audit),
      similarityMethod: (row.similarity_method as SimilarityMethod) || 'keyword_fallback',
      metadata: parseJsonObj(row.metadata),
      createdAt: row.created_at as Date,
    };
  }
}

function recognizedPriorSelfFromEvidence(evidence: SessionEvidence): boolean {
  return evidence.recalledSessionIds.length > 0 || evidence.recalledMemoryIds.length > 0;
}

function parseJsonArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseJsonArrayAsObjects(val: unknown): Record<string, unknown>[] {
  if (Array.isArray(val)) return val as Record<string, unknown>[];
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseJsonObj(val: unknown): Record<string, unknown> | undefined {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  if (typeof val === 'string') {
    try {
      return JSON.parse(val) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

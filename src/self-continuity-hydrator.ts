import type { DatabasePool } from './types.js';
import type {
  SelfContinuityRecord,
  SelfContinuityConfig,
} from './self-continuity-types.js';
import { SelfContinuityGenerator } from './self-continuity-generator.js';
import { redact } from './redactor.js';
import { jsonExtractText, dialectFromPool } from './db/query-dialect.js';

export interface HydratedSelfContinuityRecord {
  recordId: number;
  createdAt: Date | undefined;
  triggerType: string;
  confidenceScore: number;
  selfObservation: string;
  evidenceAnchors: string[];
  continuityGap: string;
  driftSummary: string;
  similarityMethod: string;
  hydratedAt: Date;
}

export interface HydrationResult {
  records: HydratedSelfContinuityRecord[];
  fallbackUsed: boolean;
  recordsRequested: number;
  recordsHydrated: number;
}

const CANONICAL_FIELDS = [
  'recordId',
  'createdAt',
  'triggerType',
  'selfObservation',
  'evidenceAnchors',
  'continuityGap',
  'confidenceScore',
  'driftSummary',
  'similarityMethod',
] as const;

export class SelfContinuityHydrator {
  private pool: DatabasePool;
  private config: SelfContinuityConfig;

  constructor(pool: DatabasePool, config?: Partial<SelfContinuityConfig>) {
    this.pool = pool;
    this.config = {
      enabled: true,
      maxRecordsPerSession: 3,
      maxInjectRecords: 3,
      maxInjectTokens: 600,
      injectionTriggers: [
        'user_asks_about_memory',
        'checkpoint_resume',
        'continuity_gap_detected',
        'explicit_reflection',
      ],
      evidenceMinAnchors: 1,
      confidenceFloor: 0.1,
      ...config,
    };
  }

  async getRecordById(recordId: number): Promise<HydratedSelfContinuityRecord | null> {
    try {
      const d = dialectFromPool(this.pool);
      const result = await this.pool.query(
        `SELECT * FROM self_continuity_records
         WHERE id = $1
         AND (${jsonExtractText(d, 'metadata', 'synthetic_test')} IS NULL OR ${jsonExtractText(d, 'metadata', 'synthetic_test')} != 'true')`,
        [recordId],
      );

      if (result.rows.length === 0) return null;

      const row = result.rows[0] as Record<string, unknown>;
      const record = SelfContinuityGenerator.dbRowToRecord(row);
      return this.hydrateRecord(record);
    } catch {
      return null;
    }
  }

  async recallWithHydration(
    projectId: string | undefined,
    limit?: number,
  ): Promise<HydrationResult> {
    const effectiveLimit = Math.min(
      limit ?? this.config.maxInjectRecords,
      this.config.maxInjectRecords,
    );

    const rawRecords = await SelfContinuityGenerator.recallRecords(
      this.pool,
      projectId,
      effectiveLimit,
    );

    if (rawRecords.length === 0) {
      return {
        records: [],
        fallbackUsed: true,
        recordsRequested: effectiveLimit,
        recordsHydrated: 0,
      };
    }

    const hydrated = rawRecords
      .filter(r => r.continuityConfidence >= this.config.confidenceFloor)
      .map(r => this.hydrateRecord(r));

    return {
      records: hydrated,
      fallbackUsed: false,
      recordsRequested: effectiveLimit,
      recordsHydrated: hydrated.length,
    };
  }

  hydrateRecord(record: SelfContinuityRecord): HydratedSelfContinuityRecord {
    const obsResult = redact(record.selfObservation ?? '');
    const safeObservation = obsResult.text ?? record.selfObservation ?? '';

    const driftSummary = this.buildDriftSummary(record);
    const continuityGap = this.extractContinuityGap(record);

    return {
      recordId: record.id ?? 0,
      createdAt: record.createdAt,
      triggerType: record.triggerType,
      confidenceScore: record.continuityConfidence,
      selfObservation: safeObservation,
      evidenceAnchors: record.evidenceAnchors ?? [],
      continuityGap,
      driftSummary,
      similarityMethod: record.similarityMethod ?? 'keyword_fallback',
      hydratedAt: new Date(),
    };
  }

  formatForInjection(hydrated: HydratedSelfContinuityRecord): string {
    const lines = [
      `[Self-Continuity Record #${hydrated.recordId}]`,
      `created: ${hydrated.createdAt?.toISOString() ?? 'unknown'}`,
      `trigger: ${hydrated.triggerType}`,
      `confidence: ${hydrated.confidenceScore.toFixed(2)}`,
      `self_observation: ${hydrated.selfObservation}`,
      `evidence_anchors: [${hydrated.evidenceAnchors.join('; ')}]`,
      `continuity_gap: ${hydrated.continuityGap}`,
      `drift_summary: ${hydrated.driftSummary}`,
      `similarity_method: ${hydrated.similarityMethod}`,
    ];
    return lines.join('\n');
  }

  formatAllForInjection(result: HydrationResult): string {
    if (result.records.length === 0) {
      return '[No self-continuity records available]';
    }

    return result.records
      .map(r => this.formatForInjection(r))
      .join('\n\n');
  }

  static getCanonicalFields(): readonly string[] {
    return CANONICAL_FIELDS;
  }

  private buildDriftSummary(record: SelfContinuityRecord): string {
    const drift = record.identityDrift;
    if (!drift) return 'no drift data';

    const parts: string[] = [];
    if (drift.goalDrift) parts.push(`goal: ${drift.goalDrift}`);
    if (drift.styleDrift) parts.push(`style: ${drift.styleDrift}`);
    if (drift.confidenceDrift) parts.push(`confidence: ${drift.confidenceDrift}`);
    if (drift.lessonAdoption) parts.push(`lessons: ${drift.lessonAdoption}`);

    return parts.length > 0 ? parts.join(', ') : 'no drift data';
  }

  private extractContinuityGap(record: SelfContinuityRecord): string {
    const drift = record.identityDrift;
    if (drift?.continuityGap) {
      return drift.continuityGap.replace(/_/g, ' ');
    }
    return 'unknown';
  }
}

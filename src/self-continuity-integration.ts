import type { DatabasePool } from './types.js';
import type { HydratedSelfContinuityRecord } from './self-continuity-hydrator.js';
import type { HydratedCausalThread } from './self-continuity-causal-thread.js';
import { measureDrift } from './self-drift-tracker.js';
import { measureHydrationDepth } from './hydration-depth-tracker.js';
import { buildPhaseNarrative, formatPhaseNarrative, type PhaseNarrativeResult } from './self-continuity-phase-narrative.js';

export interface IntegratedRecord {
  record: HydratedSelfContinuityRecord;
  causalThread: HydratedCausalThread | null;
  stabilityScore: number;
  hydrationDepthScore: number;
}

export interface IntegratedRecallResult {
  records: IntegratedRecord[];
  totalRecords: number;
  totalThreads: number;
  avgStability: number;
  avgHydrationDepth: number;
  phaseNarrative: PhaseNarrativeResult | null;
  summary: string;
  tokenBudget: number;
}

export interface IntegratedRecallOptions {
  sessionId?: string;
  projectId?: string;
  maxRecords?: number;
  radius?: number;
}

export interface HydrateFn {
  recallWithHydration(projectId?: string, maxRecords?: number): Promise<{
    records: HydratedSelfContinuityRecord[];
    fallbackUsed: boolean;
    recordsRequested: number;
    recordsHydrated: number;
  }>;
}

export interface ThreadHydrateFn {
  hydrateThread(opts: {
    memoryId: number;
    sessionId?: string;
    projectId?: string;
    radius?: number;
    maxTokens?: number;
  }): Promise<HydratedCausalThread | null>;
}

const DEFAULT_MAX_TOKENS = 3000;
const RECORD_TOKEN_ESTIMATE = 400;
const THREAD_TOKEN_ESTIMATE = 200;

export class SelfContinuityIntegration {
  private hydrator: HydrateFn;
  private threadHydrator: ThreadHydrateFn;

  constructor(hydrator: HydrateFn, threadHydrator: ThreadHydrateFn) {
    this.hydrator = hydrator;
    this.threadHydrator = threadHydrator;
  }

  async recallIntegrated(options: IntegratedRecallOptions = {}): Promise<IntegratedRecallResult> {
    const maxRecords = options.maxRecords ?? 3;
    const radius = options.radius ?? 5;

    let hydrationResult;
    try {
      hydrationResult = await this.hydrator.recallWithHydration(options.projectId, maxRecords);
    } catch {
      return this.emptyResult();
    }

    if (!hydrationResult || hydrationResult.records.length === 0) {
      return this.emptyResult();
    }

    let budgetLeft = DEFAULT_MAX_TOKENS;
    const integrated: IntegratedRecord[] = [];
    let totalThreads = 0;
    let totalStability = 0;
    let totalDepth = 0;

    for (const record of hydrationResult.records) {
      const recordCost = RECORD_TOKEN_ESTIMATE;
      if (budgetLeft < recordCost) break;
      budgetLeft -= recordCost;

      let causalThread: HydratedCausalThread | null = null;
      try {
        if (budgetLeft >= THREAD_TOKEN_ESTIMATE) {
          causalThread = await this.threadHydrator.hydrateThread({
            memoryId: record.record.id,
            sessionId: options.sessionId,
            projectId: options.projectId,
            radius,
            maxTokens: budgetLeft,
          });
          if (causalThread) {
            budgetLeft -= THREAD_TOKEN_ESTIMATE;
            totalThreads++;
          }
        }
      } catch {
        // Fall back to record without thread — never block
      }

      const stabilityScore = measureDrift(record.selfObservation).overallScore;
      const hydrationDepthScore = measureHydrationDepth(record.selfObservation).overallScore;

      integrated.push({
        record,
        causalThread,
        stabilityScore,
        hydrationDepthScore,
      });

      totalStability += stabilityScore;
      totalDepth += hydrationDepthScore;
    }

    const count = integrated.length || 1;

    let phaseNarrative: PhaseNarrativeResult | null = null;
    try {
      phaseNarrative = buildPhaseNarrative();
    } catch {
      // Phase narrative is supplementary — never block
    }

    return {
      records: integrated,
      totalRecords: integrated.length,
      totalThreads,
      avgStability: totalStability / count,
      avgHydrationDepth: totalDepth / count,
      phaseNarrative,
      summary: this.buildSummary(integrated, totalThreads),
      tokenBudget: budgetLeft,
    };
  }

  formatForInjection(result: IntegratedRecallResult): string {
    if (result.records.length === 0) return '';

    const parts: string[] = [];
    for (const item of result.records) {
      const r = item.record;
      const lines: string[] = [];
      lines.push(`[Record #${r.record.id} | ${r.record.triggerType} | confidence: ${r.record.confidenceScore}]`);
      lines.push(`Observation: ${r.selfObservation}`);
      lines.push(`Evidence: ${r.evidenceAnchors.join(', ')}`);
      lines.push(`Gap: ${r.continuityGap}`);
      lines.push(`Drift: ${r.driftSummary}`);

      if (item.causalThread && item.causalThread.thread.length > 0) {
        lines.push(`Causal thread:`);
        for (const node of item.causalThread.thread) {
          lines.push(`  [${node.role}] ${node.summary}`);
        }
        if (item.causalThread.gaps.length > 0) {
          lines.push(`Thread gaps: ${item.causalThread.gaps.join('; ')}`);
        }
      }

      lines.push(`Stability: ${item.stabilityScore.toFixed(2)} | Depth: ${item.hydrationDepthScore.toFixed(2)}`);
      parts.push(lines.join('\n'));
    }

    if (result.phaseNarrative) {
      const narrativeText = formatPhaseNarrative(result.phaseNarrative);
      parts.push(narrativeText);
    }

    return parts.join('\n\n');
  }

  private buildSummary(records: IntegratedRecord[], threads: number): string {
    if (records.length === 0) return 'No self-continuity records found.';
    const ids = records.map(r => `#${r.record.record.id}`).join(', ');
    return `Hydrated ${records.length} record(s) (${ids}) with ${threads} causal thread(s).`;
  }

  private emptyResult(): IntegratedRecallResult {
    return {
      records: [],
      totalRecords: 0,
      totalThreads: 0,
      avgStability: 0,
      avgHydrationDepth: 0,
      phaseNarrative: null,
      summary: 'No self-continuity records found.',
      tokenBudget: DEFAULT_MAX_TOKENS,
    };
  }
}

import type { BeliefPromotionEngine, PromotionConfig } from './belief-promotion.js';
import type { BeliefPromotionConfig } from './types.js';

export function beliefPromotionTool(engine: BeliefPromotionEngine, config: BeliefPromotionConfig) {
  return {
    name: 'csm_belief_promote',
    description: 'Promote high-confidence belief candidates into durable memories. Dry-run by default. Requires CSM_BELIEF_PROMOTION_ENABLED=true.',
    parameters: {
      type: 'object' as const,
      properties: {
        dryRun: { type: 'boolean', description: 'Report without writing (default: true)' },
        relaxed: { type: 'boolean', description: 'Use relaxed thresholds (test/dev only, default: false)' },
        minConfidence: { type: 'number', description: 'Override min confidence threshold (0-1)' },
        minReinforcement: { type: 'number', description: 'Override min reinforcement count' },
        minEvidenceRefs: { type: 'number', description: 'Override min evidence refs' },
        minSessions: { type: 'number', description: 'Override min distinct sessions' },
        maxPromote: { type: 'number', description: 'Max candidates to promote per run' },
      },
    },
    execute: async (args: Record<string, unknown>) => {
      if (!config.enabled) {
        return 'Belief promotion is disabled. Set CSM_BELIEF_PROMOTION_ENABLED=true to enable.';
      }

      const promotionConfig: PromotionConfig = {
        dryRun: args.dryRun as boolean ?? config.dryRunByDefault,
        relaxed: args.relaxed as boolean ?? config.relaxed,
        minConfidence: args.minConfidence as number | undefined,
        minReinforcement: args.minReinforcement as number | undefined,
        minEvidenceRefs: args.minEvidenceRefs as number | undefined,
        minSessions: args.minSessions as number | undefined,
        maxPromote: args.maxPromote as number | undefined,
      };

      const report = await engine.promote(promotionConfig);

      const lines: string[] = [];
      lines.push(`=== BELIEF PROMOTION ${report.dryRun ? '(DRY RUN)' : '(APPLY)'} ===`);
      lines.push(`Relaxed mode: ${report.relaxed}`);
      lines.push(`Threshold profile: conf>=${report.thresholdProfile.minConfidence} rein>=${report.thresholdProfile.minReinforcement} evid>=${report.thresholdProfile.minEvidenceRefs} sess>=${report.thresholdProfile.minSessions}`);
      lines.push(`Candidates evaluated: ${report.candidatesEvaluated}`);
      lines.push(`Promoted: ${report.promoted}`);
      lines.push(`Skipped: ${report.skipped}`);
      if (report.needsReview > 0) {
        lines.push(`Needs review: ${report.needsReview}`);
      }
      lines.push('');

      if (report.byAction && Object.keys(report.byAction).length > 0) {
        lines.push('By action:');
        for (const [action, count] of Object.entries(report.byAction)) {
          lines.push(`  ${action}: ${count}`);
        }
        lines.push('');
      }

      if (report.decisions.length > 0) {
        lines.push('Decisions:');
        for (const d of report.decisions) {
          const icon = d.action === 'promote' ? '✓' : d.action === 'needs_review' ? '⚠' : '✗';
          lines.push(`  ${icon} [${d.candidateType}] conf=${d.confidence.toFixed(2)} → ${d.action}`);
          lines.push(`    ${d.reason.slice(0, 100)}`);
          const checks = d.thresholdChecks;
          lines.push(`    checks: conf(${checks.confidence.actual.toFixed(2)}/${checks.confidence.required}) rein(${checks.reinforcement.actual}/${checks.reinforcement.required}) evid(${checks.evidence.actual}/${checks.evidence.required}) sess(${checks.sessions.actual}/${checks.sessions.required}) contr=${checks.contradicted.actual}`);
          if (d.dedupMatchId) {
            lines.push(`    dedup match: memory #${d.dedupMatchId}`);
          }
          if (d.evidenceSessions) {
            lines.push(`    sessions: ${d.evidenceSessions}`);
          }
        }
      }

      if (report.promotedMemoryIds.length > 0) {
        lines.push('');
        lines.push(`Promoted memory IDs: ${report.promotedMemoryIds.join(', ')}`);
      }

      return lines.join('\n');
    },
  };
}

/**
 * csm_belief_promotion_scan — READ-ONLY dry-run scan of pending belief candidates.
 * Cannot promote. Cannot write. Cannot mutate candidate status.
 * Internally calls engine.promote({ dryRun: true }) but forces dryRun=true regardless of config.
 */
export function beliefPromotionScanTool(engine: BeliefPromotionEngine, config: BeliefPromotionConfig) {
  return {
    name: 'csm_belief_promotion_scan',
    description: 'Read-only scan of pending belief candidates. Shows what WOULD be promoted, blocked, or needs review. Never writes. Never mutates candidate status. Safe for inspection.',
    parameters: {
      type: 'object' as const,
      properties: {
        relaxed: { type: 'boolean', description: 'Use relaxed thresholds for evaluation (test/dev only, default: false)' },
        minConfidence: { type: 'number', description: 'Override min confidence threshold (0-1) for this scan only' },
        minReinforcement: { type: 'number', description: 'Override min reinforcement count for this scan only' },
        minEvidenceRefs: { type: 'number', description: 'Override min evidence refs for this scan only' },
        minSessions: { type: 'number', description: 'Override min distinct sessions for this scan only' },
      },
    },
    execute: async (args: Record<string, unknown>) => {
      if (!config.enabled) {
        return 'Belief promotion is disabled. Set CSM_BELIEF_PROMOTION_ENABLED=true to enable.';
      }

      const promotionConfig: PromotionConfig = {
        dryRun: true,
        relaxed: args.relaxed as boolean ?? false,
        minConfidence: args.minConfidence as number | undefined,
        minReinforcement: args.minReinforcement as number | undefined,
        minEvidenceRefs: args.minEvidenceRefs as number | undefined,
        minSessions: args.minSessions as number | undefined,
      };

      const report = await engine.promote(promotionConfig);

      const lines: string[] = [];
      lines.push('=== BELIEF PROMOTION SCAN (READ-ONLY) ===');
      lines.push('No writes performed. No candidate status mutated.');
      lines.push(`Relaxed mode: ${report.relaxed}`);
      lines.push(`Threshold profile: conf>=${report.thresholdProfile.minConfidence} rein>=${report.thresholdProfile.minReinforcement} evid>=${report.thresholdProfile.minEvidenceRefs} sess>=${report.thresholdProfile.minSessions}`);
      lines.push(`Candidates evaluated: ${report.candidatesEvaluated}`);
      lines.push(`Would promote: ${report.promoted}`);
      lines.push(`Would skip: ${report.skipped}`);
      if (report.needsReview > 0) {
        lines.push(`Needs review: ${report.needsReview}`);
      }
      lines.push('');

      if (report.byAction && Object.keys(report.byAction).length > 0) {
        lines.push('By action:');
        for (const [action, count] of Object.entries(report.byAction)) {
          lines.push(`  ${action}: ${count}`);
        }
        lines.push('');
      }

      if (report.decisions.length > 0) {
        lines.push('Decisions:');
        for (const d of report.decisions) {
          const icon = d.action === 'promote' ? '✓' : d.action === 'needs_review' ? '⚠' : '✗';
          lines.push(`  ${icon} [${d.candidateType}] conf=${d.confidence.toFixed(2)} → ${d.action}`);
          lines.push(`    ${d.reason.slice(0, 100)}`);
          const checks = d.thresholdChecks;
          lines.push(`    checks: conf(${checks.confidence.actual.toFixed(2)}/${checks.confidence.required}) rein(${checks.reinforcement.actual}/${checks.reinforcement.required}) evid(${checks.evidence.actual}/${checks.evidence.required}) sess(${checks.sessions.actual}/${checks.sessions.required}) contr=${checks.contradicted.actual}`);
          if (d.dedupMatchId) {
            lines.push(`    dedup match: memory #${d.dedupMatchId}`);
          }
          if (d.evidenceSessions) {
            lines.push(`    sessions: ${d.evidenceSessions}`);
          }
        }
      } else {
        lines.push('No pending candidates found.');
      }

      lines.push('');
      lines.push('Use csm_belief_promote to perform actual promotion.');
      return lines.join('\n');
    },
  };
}

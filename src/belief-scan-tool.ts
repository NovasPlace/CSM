import { tool } from '@opencode-ai/plugin/tool';
import { BeliefPromotionScanner, BELIEF_CANDIDATE_TYPES, type BeliefScanConfig, type BeliefCandidateType } from './belief-promotion-scanner.js';

export function beliefScanTool(scanner: BeliefPromotionScanner) {
  return tool({
    description:
      'Scan experience packets for recurring patterns and write belief candidates ' +
      '(candidate_belief, candidate_preference, candidate_worldview, candidate_drift_warning) ' +
      'to the unified memory_candidate_queue. ADVISORY ONLY: writes candidates, never promotes to memories. ' +
      'Dry-run by default.',
    args: {
      dryRun: tool.schema.boolean().optional().describe('Report without writing candidates (default true)'),
      types: tool.schema.array(tool.schema.enum(['candidate_belief', 'candidate_preference', 'candidate_worldview', 'candidate_drift_warning'])).optional().describe('Candidate types to generate (default: all)'),
      maxPerType: tool.schema.number().optional().describe('Max candidates per type (default 20)'),
      lookbackMinutes: tool.schema.number().optional().describe('How far back to scan packets (default 1440 = 24h)'),
      minPacketCount: tool.schema.number().optional().describe('Min packets to form a candidate (default 2)'),
      projectId: tool.schema.string().optional().describe('Optional project scope filter'),
    },
    async execute(args) {
      const config: BeliefScanConfig = {
        dryRun: args.dryRun ?? true,
        types: args.types as BeliefCandidateType[] | undefined,
        maxPerType: args.maxPerType ?? 20,
        lookbackMinutes: args.lookbackMinutes ?? 1440,
        minPacketCount: args.minPacketCount ?? 2,
        projectId: args.projectId,
      };

      const report = await scanner.scan(config);

      const lines: string[] = [
        `Mode: ${report.dryRun ? 'DRY RUN (no writes)' : 'APPLY'}`,
        `Packets scanned: ${report.packetsScanned}`,
        `Patterns found: ${report.patternsFound}`,
        `Candidates: ${report.candidates.length}`,
        report.dryRun ? '' : `Inserted: ${report.inserted} | Updated: ${report.updated} | Skipped: ${report.skippedDuplicates}`,
        'By type:',
        ...BELIEF_CANDIDATE_TYPES.map(t => `  ${t}: ${report.byType[t] ?? 0}`),
        '',
      ];

      if (report.candidates.length > 0) {
        lines.push('Candidates:');
        const thresholdLabel = (conf: number) =>
          conf >= 0.7 ? 'PROMOTION-WORTHY' : conf >= 0.45 ? 'NOTABLE' : 'LOW';
        for (const c of report.candidates.slice(0, 30)) {
          lines.push(
            `  [${c.candidateType}] ${thresholdLabel(c.confidence)} (conf: ${(c.confidence * 100).toFixed(0)}%) ${c.dedupKey}`,
            `    ${c.reason}`,
          );
        }
        if (report.candidates.length > 30) {
          lines.push(`  ... and ${report.candidates.length - 30} more`);
        }
      }

      return {
        title: 'Belief Scan',
        output: lines.join('\n'),
        metadata: report,
      };
    },
  });
}

export function beliefScanReportTool(scanner: BeliefPromotionScanner) {
  return tool({
    description: 'Show stored belief candidate counts by type and status.',
    args: {},
    async execute() {
      const report = await scanner.report();

      const lines = [
        '=== BELIEF CANDIDATE QUEUE REPORT ===',
        `Total: ${report.total}`,
        '',
        'By type:',
        ...Object.entries(report.byType).map(([t, n]) => `  ${t}: ${n}`),
        '',
        'By status:',
        ...Object.entries(report.byStatus).map(([s, n]) => `  ${s}: ${n}`),
      ];

      return {
        title: 'Belief Candidate Queue Report',
        output: lines.join('\n'),
        metadata: report,
      };
    },
  });
}

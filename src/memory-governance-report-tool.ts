import { tool } from '@opencode-ai/plugin/tool';
import type { GovernanceBucket, GovernanceReport } from './memory-governance-report.js';
import { MemoryGovernanceReportBuilder } from './memory-governance-report.js';

export function memoryGovernanceReportTool(builder: MemoryGovernanceReportBuilder) {
  return tool({
    description:
      'Produce a read-only governance candidate report from stored memory scores and access signals. ' +
      'No pruning, archiving, or recall behavior changes. Reports low-quality, stale, superseded, low-access, and type-specific junk candidates.',
    args: {
      projectId: tool.schema.string().optional().describe('Optional project scope filter'),
      maxPerCategory: tool.schema.number().optional().describe('Max sample rows per category (default 20)'),
      staleDays: tool.schema.number().optional().describe('Age threshold for stale candidates (default 45)'),
    },
    async execute(args) {
      const report = await builder.build({
        projectId: args.projectId,
        maxPerCategory: args.maxPerCategory ?? 20,
        staleDays: args.staleDays ?? 45,
      });

      return {
        title: 'Memory Governance Report',
        output: formatReport(report),
        metadata: report,
      };
    },
  });
}

function formatReport(report: GovernanceReport) {
  const lines = [
    `Scanned total: ${report.scannedTotal}`,
    `Active memories: ${report.activeMemories}`,
    `Scored active: ${report.scoredActive}`,
    `Superseded memories: ${report.supersededMemories}`,
    `Archived memories: ${report.archivedMemories}`,
  ];
  const reasonEntries = Object.entries(report.archivedByReason ?? {}).sort((a, b) => b[1] - a[1]);
  if (reasonEntries.length > 0) {
    lines.push(`Archived by reason:`);
    for (const [reason, count] of reasonEntries) lines.push(`  ${reason}: ${count}`);
  }
  lines.push('');
  addBucket(lines, 'Low quality', report.categories.lowQuality);
  addBucket(lines, 'Stale', report.categories.stale);
  addBucket(lines, 'Low access', report.categories.lowAccess);
  addBucket(lines, 'Duplicate superseded', report.categories.supersededDuplicates);
  addBucket(lines, 'Type-specific junk', report.categories.typeSpecificJunk);
  return lines.join('\n');
}

function addBucket(lines: string[], label: string, bucket: GovernanceBucket) {
  lines.push(`${label}: ${bucket.count}`);
  lines.push(`  By type: ${formatTypes(bucket.byType)}`);
  for (const sample of bucket.samples.slice(0, 5)) {
    lines.push(
      `  #${sample.memoryId} ${sample.memoryType} score=${sample.score ?? 'n/a'} age=${sample.ageDays}d access=${sample.accessCount} recall=${sample.recallCount}`,
      `    ${sample.snippet}`,
    );
  }
  lines.push('');
}

function formatTypes(types: Record<string, number>) {
  const entries = Object.entries(types);
  if (entries.length === 0) return '(none)';
  return entries.map(([type, count]) => `${type}=${count}`).join(', ');
}

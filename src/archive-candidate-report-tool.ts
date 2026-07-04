import { tool } from '@opencode-ai/plugin/tool';
import type { ArchiveBucket, ArchiveCandidateReport } from './archive-candidate-report.js';
import { ArchiveCandidateReportBuilder } from './archive-candidate-report.js';

export function archiveCandidateReportTool(builder: ArchiveCandidateReportBuilder) {
  return tool({
    description:
      'Produce a read-only archive-candidate report from safe governance buckets only. ' +
      'No archive, prune, delete, or recall behavior changes are performed.',
    args: {
      projectId: tool.schema.string().optional().describe('Optional project scope filter'),
      maxPerReason: tool.schema.number().optional().describe('Max sample rows per reason code (default 20)'),
    },
    async execute(args) {
      const report = await builder.build({ projectId: args.projectId, maxPerReason: args.maxPerReason ?? 20 });
      return { title: 'Memory Archive Candidate Report', output: formatArchiveCandidateReport(report), metadata: report };
    },
  });
}

export function formatArchiveCandidateReport(report: ArchiveCandidateReport) {
  const lines = [
    report.reversibilityNote,
    '',
    `Scanned total: ${report.scannedTotal}`,
    `Active memories: ${report.activeMemories}`,
    `Archive candidates: ${report.candidateCount}`,
    `Overlap count: ${report.overlapCount}`,
    `Excluded low-access count: ${report.excludedCounts.lowAccess}`,
    `Excluded medium-band conversations: ${report.excludedCounts.mediumBandConversation}`,
  ];
  const summary = report.archivedSummary;
  if (summary && summary.total > 0) {
    lines.push('', `Archived (already actioned): ${summary.total}`);
    const reasonEntries = Object.entries(summary.byReason ?? {}).sort((a, b) => b[1] - a[1]);
    for (const [reason, count] of reasonEntries) lines.push(`  ${reason}: ${count}`);
  }
  lines.push('');
  addBucket(lines, 'Already superseded duplicate', report.categories.already_superseded_duplicate);
  addBucket(lines, 'Tiny type-specific junk', report.categories.tiny_type_specific_junk);
  return lines.join('\n');
}

function addBucket(lines: string[], label: string, bucket: ArchiveBucket) {
  lines.push(`${label}: ${bucket.count}`);
  lines.push(`  By type: ${formatTypes(bucket.byType)}`);
  for (const sample of bucket.samples.slice(0, 5)) {
    lines.push(
      `  #${sample.memoryId} ${sample.reasonCode} ${sample.memoryType} score=${sample.score ?? 'n/a'} age=${sample.ageDays}d access=${sample.accessCount} recall=${sample.recallCount}`,
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

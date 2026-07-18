import { tool } from '@opencode-ai/plugin/tool';
import { EmbeddingBackfill, type EmbeddingBackfillConfig } from './embedding-backfill.js';
import { DedupCandidateDetector, type DedupDetectorConfig } from './dedup-detector.js';
import { MemoryMerger, type MergeConfig } from './merge-tool.js';
import {
  CandidateGenerator,
  type CandidateGeneratorConfig,
  type CandidateType,
  ALL_CANDIDATE_TYPES,
} from './candidate-generator.js';

export function memoryDedupDetectTool(detector: DedupCandidateDetector, projectId: string) {
  return tool({
    description:
      'Find candidate duplicate memory clusters using exact content/title matching and embedding similarity. ' +
      'Read-only: never modifies memory data. Reports clusters with representative + duplicate IDs.',
    args: {
      similarityThreshold: tool.schema.number().optional().describe('Cosine similarity threshold (0-1, default 0.92)'),
      maxClusters: tool.schema.number().optional().describe('Max clusters to return (default 50)'),
      allowedTypes: tool.schema.array(tool.schema.string()).optional().describe('Only check these memory types'),
      includeDifferentTypes: tool.schema.boolean().optional().describe('Allow cross-type embedding clusters (default false)'),
    },
    async execute(args) {
      const config: DedupDetectorConfig = {
        similarityThreshold: args.similarityThreshold ?? 0.92,
        maxClusters: args.maxClusters ?? 50,
        allowedTypes: args.allowedTypes,
        includeDifferentTypes: args.includeDifferentTypes ?? false,
        projectId,
      };

      const report = await detector.findCandidates(config);

      const lines = [
        `Total candidates scanned: ${report.totalCandidates}`,
        `Threshold used: ${report.thresholdUsed}`,
        `Duplicate clusters found: ${report.clusters.length}`,
        '',
      ];
      for (let i = 0; i < report.clusters.length; i++) {
        const c = report.clusters[i];
        lines.push(
          `Cluster ${i + 1}: ${c.detectionMethod} (size=${c.clusterSize}, avgSim=${c.averageSimilarity.toFixed(4)})`,
          `  Representative: id=${c.representative.id} type=${c.representative.memoryType} title="${c.representative.title}"`,
          `  Duplicates: [${c.duplicateIds.join(', ')}]`,
        );
      }

      return {
        title: 'Dedup Candidate Detection',
        output: lines.join('\n'),
        metadata: report,
      };
    },
  });
}

export function memoryMergeDuplicatesTool(merger: MemoryMerger, projectId: string) {
  return tool({
    description:
      'Merge exact content duplicate memories by marking superseded. ' +
      'Dry-run first to review candidates. ' +
      'Only exact normalized content matches. Lessons excluded by default.',
    args: {
      dryRun: tool.schema.boolean().optional().describe('Report without writing (default true)'),
      memoryTypes: tool.schema.array(tool.schema.string()).optional().describe('Only process these types'),
      excludeTypes: tool.schema.array(tool.schema.string()).optional().describe('Skip these types (default: ["lesson"])'),
      maxGroups: tool.schema.number().optional().describe('Max groups to process, 0 = unlimited (default 0)'),
    },
    async execute(args) {
      const config: MergeConfig = {
        dryRun: args.dryRun ?? true,
        memoryTypes: args.memoryTypes,
        excludeTypes: args.excludeTypes,
        projectId,
        maxGroups: args.maxGroups,
      };

      const report = await merger.merge(config);

      const lines = [
        `Mode: ${report.dryRun ? 'DRY RUN (no writes)' : 'APPLY'}`,
        `Active before: ${report.activeBefore}`,
        `Active after: ${report.activeAfter}`,
        `Canonical kept: ${report.totalCanonical}`,
        `Duplicates marked superseded: ${report.totalDuplicates}`,
        `Types processed: ${report.typesProcessed.length > 0 ? report.typesProcessed.join(', ') : '(all non-excluded)'}`,
        `Excluded types: ${report.excludedTypes.join(', ')}`,
        '',
      ];
      for (let i = 0; i < Math.min(report.groups.length, 30); i++) {
        const g = report.groups[i];
        lines.push(
          `Group ${i + 1}: type=${g.memoryType} count=${g.duplicateCount}` +
          ` canonical=#${g.canonicalId} dups=[${g.duplicateIds.join(',')}]`,
          `  Content: ${g.content.slice(0, 100)}`,
        );
      }
      if (report.groups.length > 30) {
        lines.push(`... and ${report.groups.length - 30} more groups`);
      }

      return {
        title: 'Memory Merge',
        output: lines.join('\n'),
        metadata: report,
      };
    },
  });
}

export function memoryBackfillEmbeddingsTool(backfill: EmbeddingBackfill, projectId: string) {
  return tool({
    description:
      'Backfill missing memory embeddings for legacy rows. ' +
      'Processes in batches with rate-limiting. Resumes on interruption. ' +
      'Explicit maintenance action only; never runs on startup.',
    args: {
      batchSize: tool.schema.number().optional().describe('Memories per batch (default 50)'),
      maxTotal: tool.schema.number().optional().describe('Max total to process, 0 = unlimited (default 0)'),
      dryRun: tool.schema.boolean().optional().describe('Count eligible rows without updating them'),
      batchDelayMs: tool.schema.number().optional().describe('Rate-limit delay in ms between batches (default 100)'),
    },
    async execute(args) {
      const config: EmbeddingBackfillConfig = {
        batchSize: args.batchSize ?? 50,
        maxTotal: args.maxTotal ?? 0,
        projectId,
        dryRun: args.dryRun ?? false,
        batchDelayMs: args.batchDelayMs ?? 100,
      };

      const result = await backfill.backfill(config);

      return {
        title: 'Embedding Backfill',
        output:
          `Total missing: ${result.totalMissing}\n` +
          `Attempted: ${result.attempted}\n` +
          `Succeeded: ${result.succeeded}\n` +
          `Failed: ${result.failed}\n` +
          `Skipped: ${result.skipped}\n` +
          `Complete: ${result.isComplete}`,
        metadata: result,
      };
    },
  });
}

export function memoryCandidateGenerateTool(generator: CandidateGenerator, projectId: string) {
  return tool({
    description:
      'Generate advisory maintenance candidates (prune, promote_to_lesson, merge, stale_preference, refresh_summary) ' +
      'from existing tables. ADVISORY ONLY: writes candidate rows and reasons, never prunes/merges/promotes/mutates memories. ' +
      'Dry-run by default. Dedupes repeat candidates via partial unique index.',
    args: {
      dryRun: tool.schema.boolean().optional().describe('Report without writing candidates (default true)'),
      types: tool.schema.array(tool.schema.enum(['prune', 'promote_to_lesson', 'merge', 'stale_preference', 'refresh_summary'])).optional().describe('Candidate types to generate (default: all)'),
      maxPerType: tool.schema.number().optional().describe('Max candidates per type (default 100)'),
      maxQualityScorePrune: tool.schema.number().optional().describe('Prune threshold: quality score below this (default 0.5)'),
      minAgeDaysPrune: tool.schema.number().optional().describe('Prune: min age in days (default 30)'),
      minRecallPromote: tool.schema.number().optional().describe('Promote: min recall count (default 5)'),
      minAgeDaysStalePreference: tool.schema.number().optional().describe('Stale preference: min age in days (default 60)'),
      minChunksRefresh: tool.schema.number().optional().describe('Refresh summary: min chunk count (default 3)'),
    },
    async execute(args) {
      const config: CandidateGeneratorConfig = {
        dryRun: args.dryRun ?? true,
        types: args.types as CandidateType[] | undefined,
        maxPerType: args.maxPerType ?? 100,
        maxQualityScorePrune: args.maxQualityScorePrune,
        minAgeDaysPrune: args.minAgeDaysPrune,
        minRecallPromote: args.minRecallPromote,
        minAgeDaysStalePreference: args.minAgeDaysStalePreference,
        minChunksRefresh: args.minChunksRefresh,
        projectId,
      };

      const report = await generator.generate(config);

      const lines = [
        `Mode: ${report.dryRun ? 'DRY RUN (no writes)' : 'APPLY'}`,
        `Total candidates: ${report.candidates.length}`,
        report.dryRun ? '' : `Inserted: ${report.inserted} | Skipped duplicates: ${report.skippedDuplicates}`,
        'By type:',
        ...ALL_CANDIDATE_TYPES.map(t => `  ${t}: ${report.byType[t] ?? 0}`),
        '',
      ];

      const shown = report.candidates.slice(0, 30);
      for (const c of shown) {
        const preview = c.reason;
        lines.push(
          `[${c.candidateType}] #${c.memoryId} (conf: ${c.confidence.toFixed(2)}) ${preview}`,
        );
      }
      if (report.candidates.length > 30) {
        lines.push(`... and ${report.candidates.length - 30} more candidates`);
      }

      return {
        title: 'Candidate Generation',
        output: lines.join('\n'),
        metadata: report,
      };
    },
  });
}

export function memoryCandidateReportTool(generator: CandidateGenerator, projectId: string) {
  return tool({
    description:
      'Show stored candidate counts by type and status from the advisory candidate queue.',
    args: {},
    async execute() {
      const report = await generator.report(projectId);

      const lines = [
        '=== CANDIDATE QUEUE REPORT ===',
        `Total: ${report.total}`,
        '',
        'By type:',
        ...Object.entries(report.byType).map(([t, n]) => `  ${t}: ${n}`),
        '',
        'By status:',
        ...Object.entries(report.byStatus).map(([s, n]) => `  ${s}: ${n}`),
      ];

      return {
        title: 'Candidate Queue Report',
        output: lines.join('\n'),
        metadata: report,
      };
    },
  });
}

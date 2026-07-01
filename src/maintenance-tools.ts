import { tool } from '@opencode-ai/plugin/tool';
import { EmbeddingBackfill, type EmbeddingBackfillConfig } from './embedding-backfill.js';
import { DedupCandidateDetector, type DedupDetectorConfig } from './dedup-detector.js';

export function memoryDedupDetectTool(detector: DedupCandidateDetector) {
  return tool({
    description:
      'Find candidate duplicate memory clusters using exact content/title matching and embedding similarity. ' +
      'Read-only: never modifies memory data. Reports clusters with representative + duplicate IDs.',
    args: {
      similarityThreshold: tool.schema.number().optional().describe('Cosine similarity threshold (0-1, default 0.92)'),
      maxClusters: tool.schema.number().optional().describe('Max clusters to return (default 50)'),
      allowedTypes: tool.schema.array(tool.schema.string()).optional().describe('Only check these memory types'),
      includeDifferentTypes: tool.schema.boolean().optional().describe('Allow cross-type embedding clusters (default false)'),
      projectId: tool.schema.string().optional().describe('Optional project scope filter'),
    },
    async execute(args) {
      const config: DedupDetectorConfig = {
        similarityThreshold: args.similarityThreshold ?? 0.92,
        maxClusters: args.maxClusters ?? 50,
        allowedTypes: args.allowedTypes,
        includeDifferentTypes: args.includeDifferentTypes ?? false,
        projectId: args.projectId,
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

export function memoryBackfillEmbeddingsTool(backfill: EmbeddingBackfill) {
  return tool({
    description:
      'Backfill missing memory embeddings for legacy rows. ' +
      'Processes in batches with rate-limiting. Resumes on interruption. ' +
      'Explicit maintenance action only; never runs on startup.',
    args: {
      batchSize: tool.schema.number().optional().describe('Memories per batch (default 50)'),
      maxTotal: tool.schema.number().optional().describe('Max total to process, 0 = unlimited (default 0)'),
      projectId: tool.schema.string().optional().describe('Optional project scope filter'),
      dryRun: tool.schema.boolean().optional().describe('Count eligible rows without updating them'),
      batchDelayMs: tool.schema.number().optional().describe('Rate-limit delay in ms between batches (default 100)'),
    },
    async execute(args) {
      const config: EmbeddingBackfillConfig = {
        batchSize: args.batchSize ?? 50,
        maxTotal: args.maxTotal ?? 0,
        projectId: args.projectId,
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

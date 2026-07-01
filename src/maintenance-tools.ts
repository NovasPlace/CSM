import { tool } from '@opencode-ai/plugin/tool';
import { EmbeddingBackfill, type EmbeddingBackfillConfig } from './embedding-backfill.js';

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

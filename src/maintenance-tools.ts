import { tool } from '@opencode-ai/plugin/tool';
import { MemoryManager } from './memory-manager.js';
import { backfillMissingEmbeddingsOp } from './bridge-ops.js';

export function memoryBackfillEmbeddingsTool(memoryManager: MemoryManager) {
  return tool({
    description:
      'Backfill missing memory embeddings for legacy rows. Explicit maintenance action only; never runs on startup.',
    args: {
      limit: tool.schema.number().optional().describe('Max rows to process (default 100)'),
      projectId: tool.schema.string().optional().describe('Optional project scope filter'),
      dryRun: tool.schema.boolean().optional().describe('Report eligible rows without updating them'),
    },
    async execute(args) {
      const result = await backfillMissingEmbeddingsOp(
        {
          memoryManager,
          contextRecall: undefined as never,
          primingEngine: undefined as never,
          contextCompactor: undefined as never,
        },
        args.limit ?? 100,
        args.projectId,
        args.dryRun ?? false,
      );

      return {
        title: 'Embedding Backfill',
        output:
          `Scanned: ${result.scanned}\n` +
          `Eligible: ${result.eligible}\n` +
          `Updated: ${result.updated}\n` +
          `Skipped: ${result.skipped}\n` +
          `Failed: ${result.failed}`,
        metadata: result,
      };
    },
  });
}

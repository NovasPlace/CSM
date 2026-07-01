import type { CheckpointStore } from '../checkpoint-store.js';
import type { CheckpointConfig } from '../checkpoint-types.js';
import { getLogger } from '../logger.js';

export type AutoCheckpointTrigger = 'context_pressure' | 'message_count' | 'risky_edit' | 'pre_compaction' | 'post_compaction';

export interface AutoCheckpointContext {
  checkpointStore: CheckpointStore;
  config: CheckpointConfig;
}

/**
 * Create an automatic checkpoint when a trigger condition is met.
 * Phase 4B — Auto-checkpoint triggers.
 */
export async function createAutoCheckpoint(
  ctx: AutoCheckpointContext,
  sessionId: string,
  trigger: AutoCheckpointTrigger,
  details?: Record<string, unknown>,
): Promise<void> {
  if (!ctx.config.auto?.enabled) return;

  try {
    const summaryLines = [
      `**Trigger:** ${trigger}`,
      details ? `**Details:** ${JSON.stringify(details)}` : '',
      `**Timestamp:** ${new Date().toISOString()}`,
    ].filter(Boolean);

    const summary = `Auto-checkpoint (${trigger}):\n${summaryLines.join('\n')}`;

    await ctx.checkpointStore.createCheckpoint({
      sessionId,
      summaryMarkdown: summary,
      summaryTokens: Math.ceil(summary.length / 4),
      inputTokensEstimate: 0,
      sourceRefs: [],
      compactedRefs: [],
      filesMentioned: [],
      testsMentioned: [],
      risks: [`Auto-checkpoint triggered by ${trigger}${details ? ': ' + JSON.stringify(details) : ''}`],
      nextSteps: ['Continue conversation'],
       rawCaptures: [],
     });

     getLogger().info(`Auto-checkpoint created: ${trigger} for session ${sessionId.slice(0, 8)}...`);
   } catch (error) {
     getLogger().error(`Auto-checkpoint failed (${trigger})`, error instanceof Error ? error : undefined);
   }
 }

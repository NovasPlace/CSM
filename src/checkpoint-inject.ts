// Phase 4A — checkpoint injection policy
// Injects latest active checkpoint into system prompt during system.transform.
// Strict budget. Never injects if session is short. Never injects all checkpoints.
import { CheckpointStore } from './checkpoint-store.js';
import { CheckpointConfig } from './checkpoint-types.js';
import { compactCheckpointMarkdown } from './prompt-budget-injection.js';
import { estimateTokens } from './token-bucket-analyzer.js';
import { logCheckpointInjected } from './checkpoint-telemetry.js';

export interface CheckpointInjectDeps {
  store: CheckpointStore;
  config: CheckpointConfig;
}

/**
 * Build the checkpoint injection string for system prompt.
 * Returns null if no injection should occur.
 * Called from experimental.chat.system.transform hook.
 */
export async function buildCheckpointInjection(
  deps: CheckpointInjectDeps,
  sessionId: string,
): Promise<string | null> {
  if (!deps.config.enabled) return null;

  const active = await deps.store.getActiveCheckpoint(sessionId);
  if (!active) return null;

  // Budget check — truncate if needed (check full injection, not just summary)
  const header = `[Session Checkpoint — ${active.checkpointId.substring(0, 8)} — ${active.createdAt.toISOString().substring(0, 19)}]`;
  const footer = `[End Checkpoint. Use expand_checkpoint_ref tool to recover full details.]`;
  const overheadTokens = estimateTokens(header) + estimateTokens(footer) + 4;
  let summary = active.summaryMarkdown;
  let summaryBudget = Math.max(120, deps.config.maxCheckpointInjectTokens - overheadTokens);

  for (let pass = 0; pass < 3; pass++) {
    const injection = `${header}\n${summary}\n${footer}`;
    if (estimateTokens(injection) <= deps.config.maxCheckpointInjectTokens) break;
    summaryBudget = Math.floor(summaryBudget * 0.7);
    summary = compactCheckpointMarkdown(summary, summaryBudget);
  }

  const injection = `${header}\n${summary}\n${footer}`;

  logCheckpointInjected({
    sessionId,
    checkpointId: active.checkpointId,
    tokensInjected: estimateTokens(injection),
    budget: deps.config.maxCheckpointInjectTokens,
    skipped: false,
    reason: 'injected',
  });

  return injection;
}

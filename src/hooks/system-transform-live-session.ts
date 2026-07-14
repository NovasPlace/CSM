import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { getActiveGoal } from '../goal-schema.js';
import { getLogger } from '../logger.js';
import {
  buildResumeInjection,
  type WorkJournalInjectDeps,
} from '../work-journal-inject.js';
import type {
  SystemTransformInput,
  SystemTransformOutput,
} from './system-transform-live-types.js';

export function injectTokenPressure(
  ctx: PluginContext,
  output: SystemTransformOutput,
): void {
  const pressureInfo = ctx.contextPressure?.getInfo();
  if (!pressureInfo) return;
  output.system.push(
    `[CONTEXT WINDOW: ${pressureInfo.estimatedTokens}/${pressureInfo.maxTokens} tokens (${pressureInfo.percentage}%). Action: ${pressureInfo.action}]`,
  );
}

export async function injectCheckpoint(
  ctx: PluginContext,
  input: SystemTransformInput,
  output: SystemTransformOutput,
): Promise<void> {
  if (!input.sessionID || !ctx.checkpointInjectDeps) return;
  const injection = await buildCheckpointInjection(
    ctx.checkpointInjectDeps,
    input.sessionID,
  );
  if (injection) output.system.push(injection);
}

export async function injectWorkJournal(
  ctx: PluginContext,
  input: SystemTransformInput,
  output: SystemTransformOutput,
): Promise<void> {
  if (!input.sessionID || !ctx.config.workJournal?.enabled) return;
  try {
    const payload = await ctx.workJournal.buildResumePayload(
      input.sessionID,
      ctx.directory,
    );
    if (!payload) return;
    const deps: WorkJournalInjectDeps = {
      maxInjectTokens: ctx.config.workJournal.injectMaxTokens,
    };
    output.system.push(buildResumeInjection(payload, deps));
    getLogger().info(
      `[WorkJournal] Injected resume payload for session ${input.sessionID.slice(0, 8)} (${payload.totalEntries} entries)`,
    );
  } catch (error) {
    getLogger().error(
      '[WorkJournal] Inject hook error:',
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

function formatGoalAge(createdAt: number): string {
  const age = Date.now() - createdAt;
  if (age < 60_000) return `${Math.round(age / 1000)}s ago`;
  if (age < 3_600_000) return `${Math.round(age / 60_000)}m ago`;
  return `${Math.round(age / 3_600_000)}h ago`;
}

export async function injectActiveGoal(
  ctx: PluginContext,
  input: SystemTransformInput,
  output: SystemTransformOutput,
): Promise<void> {
  if (!input.sessionID || ctx.config.databaseProvider !== 'postgres') return;
  try {
    const goal = await getActiveGoal(ctx.database.getPool(), input.sessionID);
    if (!goal) return;
    const parts = [
      `<active_goal id="${goal.id.slice(0, 8)}">`,
      goal.description,
      `Set ${formatGoalAge(goal.created_at)} | ID ${goal.id}`,
    ];
    if (goal.context && Object.keys(goal.context).length > 0) {
      parts.push(`Context: ${JSON.stringify(goal.context)}`);
    }
    parts.push('</active_goal>');
    output.system.push(parts.join('\n'));
  } catch {
    // Active goal injection is non-critical.
  }
}

export async function injectSessionContext(
  ctx: PluginContext,
  input: SystemTransformInput,
  output: SystemTransformOutput,
): Promise<void> {
  injectTokenPressure(ctx, output);
  await injectCheckpoint(ctx, input, output);
  await injectWorkJournal(ctx, input, output);
  await injectActiveGoal(ctx, input, output);
}


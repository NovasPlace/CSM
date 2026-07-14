import type { PluginContext } from '../plugin-context.js';
import {
  advisoryCharBudget,
  shouldInjectAdvisory,
  shouldInjectFullMemoryBrief,
  shouldInjectVcm,
  type InjectionTrimLevel,
} from '../context-cap-sensor.js';
import { getLogger } from '../logger.js';
import { injectReentryContext } from './reentry-injection-guard.js';
import { upgradeGreetingGuidance } from './system-transform-live-core.js';
import type { SystemTransformOutput } from './system-transform-live-types.js';

export function senseContextCap(
  ctx: PluginContext,
  output: SystemTransformOutput,
): InjectionTrimLevel {
  if (!ctx.contextCapSensor) return 'full';
  const cap = ctx.contextCapSensor.sense(output.system);
  getLogger().debug(`context cap: ${cap.action}`);
  return cap.trimLevel;
}

export async function injectRecallAndReentry(
  ctx: PluginContext,
  output: SystemTransformOutput,
  sessionId: string,
  greetingTurn: boolean,
  trimLevel: InjectionTrimLevel,
): Promise<void> {
  const brief = shouldInjectFullMemoryBrief(trimLevel) && ctx.contextRecall
    ? await ctx.contextRecall.getContextBrief()
    : null;
  if (brief) output.system.push(brief.compressed);
  const injected = await injectReentryContext(
    ctx,
    output,
    sessionId,
    trimLevel,
  );
  if (greetingTurn && injected) upgradeGreetingGuidance(output);
}

export async function injectLivingStateAdvisory(
  ctx: PluginContext,
  output: SystemTransformOutput,
  trimLevel: InjectionTrimLevel,
): Promise<void> {
  if (!shouldInjectAdvisory(trimLevel) || !ctx.livingStateAdvisor) return;
  try {
    const block = await ctx.livingStateAdvisor.assembleBlock();
    if (!block) return;
    const budget = ctx.config.livingState?.maxAdvisoryBlockChars ?? 600;
    const trimmed = block.slice(0, advisoryCharBudget(trimLevel, budget));
    if (trimmed.length > 0) output.system.push(trimmed);
  } catch {
    // Advisory context is non-critical.
  }
}

function injectPendingContext(
  ctx: PluginContext,
  output: SystemTransformOutput,
  trimLevel: InjectionTrimLevel,
): void {
  const fileContext = ctx.state.pendingFileContext;
  if (fileContext && trimLevel !== 'minimal') {
    output.system.push(fileContext.formatted);
    ctx.state.pendingFileContext = null;
  }
  const milestone = ctx.state.pendingMilestonePrompt;
  if (milestone && trimLevel !== 'minimal') {
    output.system.push(milestone.formatted);
    ctx.state.pendingMilestonePrompt = null;
  }
}

async function injectVcmContext(
  ctx: PluginContext,
  output: SystemTransformOutput,
  trimLevel: InjectionTrimLevel,
): Promise<void> {
  if (!shouldInjectVcm(trimLevel) || !ctx.vcmManager) return;
  try {
    const block = await ctx.vcmManager.buildContextBlock(
      ctx.state.currentSessionId ?? 'unknown',
      ctx.directory ?? 'unknown',
    );
    if (block) output.system.push(block);
  } catch {
    // VCM context is non-critical.
  }
}

export async function injectEphemeralContext(
  ctx: PluginContext,
  output: SystemTransformOutput,
  trimLevel: InjectionTrimLevel,
): Promise<void> {
  injectPendingContext(ctx, output, trimLevel);
  await injectVcmContext(ctx, output, trimLevel);
}


import { compileContext } from './context-compiler.js';
import { DEFAULT_GOVERNOR_CONFIG, getGovernorProfile } from './context-governor-profiles.js';
import { measureGovernorMetrics } from './context-governor-monitor.js';
import { optimizeGovernorContext } from './context-governor-optimizer.js';
import {
  buildCheckpointDistilledState,
  buildCheckpointRefSummary,
} from './context-governor-checkpoint.js';
import { estimateSlopeGrowth } from './context-governor-slope.js';
import { getLogger } from './logger.js';
import type {
  GovernorActionName,
  GovernorConfig,
  GovernorDecision,
  GovernorProfileName,
  GovernorResult,
} from './context-governor-types.js';
import type { ContextCompilerConfig } from './types.js';

function getThresholds(config: GovernorConfig): { lightBrief: number; compactToolCalls: number; checkpointRefsOnly: number; distilledStateOnly: number; emergencyRebuild: number } {
  const def: { lightBrief: number; compactToolCalls: number; checkpointRefsOnly: number; distilledStateOnly: number; emergencyRebuild: number } = {
    lightBrief: 50_000,
    compactToolCalls: 65_000,
    checkpointRefsOnly: 75_000,
    distilledStateOnly: 90_000,
    emergencyRebuild: 120_000,
  };

  return {
    lightBrief: config.thresholds?.lightBrief ?? def.lightBrief,
    compactToolCalls: config.thresholds?.compactToolCalls ?? def.compactToolCalls,
    checkpointRefsOnly: config.thresholds?.checkpointRefsOnly ?? def.checkpointRefsOnly,
    distilledStateOnly: config.thresholds?.distilledStateOnly ?? def.distilledStateOnly,
    emergencyRebuild: config.thresholds?.emergencyRebuild ?? def.emergencyRebuild,
  };
}

interface MessageLike {
  info?: { role?: string };
  parts?: any[];
}

function chooseAction(total: number, projected: number, budget: number, thresholds: { lightBrief: number; compactToolCalls: number; checkpointRefsOnly: number; distilledStateOnly: number; emergencyRebuild: number }): GovernorActionName {
  getLogger().debug('chooseAction');
  if (projected >= thresholds.emergencyRebuild || total > budget * 1.45) return 'emergency_context_rebuild';
  if (projected >= thresholds.distilledStateOnly) return 'distilled_project_state';
  if (projected >= thresholds.checkpointRefsOnly) return 'checkpoint_refs_only';
  if (projected >= thresholds.compactToolCalls) return 'compact_old_tool_calls';
  if (projected >= thresholds.lightBrief) return 'light_memory_brief';
  return 'none';
}

function buildReason(action: GovernorActionName, projected: number, budget: number): string {
  return `${action} selected because projected_next=${projected} and budget=${budget}`;
}

function actionBudget(
  action: GovernorActionName,
  targetBudget: number,
): number {
  if (action === 'light_memory_brief') return Math.min(targetBudget, 50_000);
  if (action === 'compact_old_tool_calls') return Math.min(targetBudget, 65_000);
  if (action === 'checkpoint_refs_only') return Math.min(targetBudget, 75_000);
  if (action === 'distilled_project_state') return Math.min(targetBudget, 90_000);
  if (action === 'emergency_context_rebuild') return Math.min(targetBudget, 20_000);
  return targetBudget;
}

function compileBudget(targetBudget: number, projectedGrowth: number): number {
  return Math.max(2_000, targetBudget - projectedGrowth);
}

function textPart(text: string): any {
  return { type: 'text', text };
}

function addMemoryBrief(messages: MessageLike[]): void {
  const summary = summarizeMessages(messages, 2, '[MEMORY_BRIEF]');
  messages.unshift({ info: { role: 'assistant' }, parts: [textPart(summary)] });
}

function summarizeMessages(messages: MessageLike[], limit: number, prefix: string): string {
  const snippets = messages
    .slice(-limit)
    .flatMap((message) => message.parts ?? [])
    .map((part) => String(part.text ?? part.state?.output ?? '').replace(/\s+/g, ' ').slice(0, 120))
    .filter((text) => text.length > 0);
  return `${prefix} ${snippets.join(' | ')}`.trim();
}

function replaceWithCheckpointRefs(messages: MessageLike[], keepTail: number): void {
  const cut = Math.max(0, messages.length - keepTail);
  const archived = messages.slice(0, cut);
  const recent = messages.slice(cut);
  if (archived.length === 0) return;
  const refs = buildCheckpointRefSummary(archived);
  messages.splice(0, messages.length, {
    info: { role: 'assistant' },
    parts: [textPart(refs)],
  }, ...recent);
}

function replaceWithDistilledState(messages: MessageLike[], keepTail: number): void {
  const distilled = `[DISTILLED_STATE]\n${buildCheckpointDistilledState(messages)}`;
  const recent = messages.slice(-keepTail);
  messages.splice(0, messages.length, {
    info: { role: 'assistant' },
    parts: [textPart(distilled)],
  }, ...recent);
}

function applyAction(messages: MessageLike[], action: GovernorActionName): boolean {
  if (action === 'light_memory_brief') {
    addMemoryBrief(messages);
    return false;
  }
  if (action === 'checkpoint_refs_only') {
    replaceWithCheckpointRefs(messages, 6);
    return true;
  }
  if (action === 'distilled_project_state' || action === 'emergency_context_rebuild') {
    replaceWithDistilledState(messages, action === 'distilled_project_state' ? 4 : 2);
    return true;
  }
  return false;
}

function buildCompilerConfig(base: ContextCompilerConfig, budget: number, recentTurnWindow: number): ContextCompilerConfig {
  return {
    ...base,
    modes: { ...base.modes, normal: budget, cheap: Math.min(base.modes.cheap, budget), deep: Math.max(base.modes.deep, budget) },
    defaultMode: 'normal',
    recentTurnWindow,
  };
}

export class AdaptiveContextGovernor {
  constructor(
    private readonly compilerConfig: ContextCompilerConfig,
    private readonly governorConfig: GovernorConfig = DEFAULT_GOVERNOR_CONFIG,
  ) {}

  govern(messages: MessageLike[], profileName?: GovernorProfileName): GovernorResult {
    const profile = getGovernorProfile(this.governorConfig, profileName);
    const slopeGrowth = estimateSlopeGrowth(messages);
    const projectedGrowth = profile.projectedGrowth + slopeGrowth;
    const before = measureGovernorMetrics(messages, projectedGrowth);
    const thresholds = getThresholds(this.governorConfig);
    const action = chooseAction(before.totalTokens, before.projectedNextTurnTokens, profile.maxBudget, thresholds);
    
    // Diagnostic logging
    getLogger().debug('DIAGNOSTIC');
    const decision: GovernorDecision = {
      profile: profile.name,
      action,
      reason: buildReason(action, before.projectedNextTurnTokens, profile.maxBudget),
      budget: actionBudget(action, profile.targetBudget),
      projectedNextTurnTokens: before.projectedNextTurnTokens,
      overBudget: before.totalTokens > profile.maxBudget,
    };
    const rebuildApplied = applyAction(messages, action);
    optimizeGovernorContext(messages, profile.recentTurnWindow);
    const compileResult = compileContext(
      messages,
      buildCompilerConfig(
        this.compilerConfig,
        compileBudget(decision.budget, projectedGrowth),
        profile.recentTurnWindow,
      ),
    );
    const after = measureGovernorMetrics(messages, projectedGrowth);
    return {
      metricsBefore: before,
      metricsAfter: after,
      decision,
      rebuildApplied,
      compileResult,
    };
  }
}

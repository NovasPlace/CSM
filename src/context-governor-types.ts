import type { CompileResult } from './context-compiler.js';

export type GovernorProfileName = 'cheap' | 'balanced' | 'deep_work' | 'emergency';

export type GovernorActionName =
  | 'none'
  | 'light_memory_brief'
  | 'compact_old_tool_calls'
  | 'checkpoint_refs_only'
  | 'distilled_project_state'
  | 'emergency_context_rebuild';

export interface GovernorThresholds {
  lightBrief: number;
  compactToolCalls: number;
  checkpointRefsOnly: number;
  distilledStateOnly: number;
  emergencyRebuild: number;
}

export interface GovernorProfile {
  name: GovernorProfileName;
  targetBudget: number;
  maxBudget: number;
  projectedGrowth: number;
  recentTurnWindow: number;
  thresholds: GovernorThresholds;
}

export interface GovernorConfig {
  enabled: boolean;
  defaultProfile: GovernorProfileName;
  profiles: Record<GovernorProfileName, GovernorProfile>;
  thresholds?: {
    lightBrief?: number;
    compactToolCalls?: number;
    checkpointRefsOnly?: number;
    distilledStateOnly?: number;
    emergencyRebuild?: number;
  };
}

export interface GovernorMetrics {
  totalTokens: number;
  toolOutputTokens: number;
  rawHistoryTokens: number;
  memoryBriefTokens: number;
  checkpointRefTokens: number;
  distilledStateTokens: number;
  rawMessagesKept: number;
  compactedMessages: number;
  projectedNextTurnTokens: number;
  toolOutputShare: number;
}

export interface GovernorDecision {
  profile: GovernorProfileName;
  action: GovernorActionName;
  reason: string;
  budget: number;
  projectedNextTurnTokens: number;
  overBudget: boolean;
}

export interface GovernorResult {
  metricsBefore: GovernorMetrics;
  metricsAfter: GovernorMetrics;
  decision: GovernorDecision;
  thresholds: GovernorThresholds;
  observedAt: string;
  rebuildApplied: boolean;
  compileResult?: CompileResult;
}

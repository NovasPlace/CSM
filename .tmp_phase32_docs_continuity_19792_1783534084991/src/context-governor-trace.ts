import { readFileSync } from 'node:fs';
import { AdaptiveContextGovernor } from './context-governor.js';
import {
  countTokens,
  evaluateContinuity,
  toolShare,
  type ScenarioFacts,
} from './context-governor-benchmark-fixtures.js';
import { DEFAULT_GOVERNOR_CONFIG } from './context-governor-profiles.js';
import type { ContextCompilerConfig } from './types.js';

interface PromptDebugPart {
  type: string;
  tool?: string;
  textLength?: number;
  textPreview?: string;
  stateStatus?: string;
  toolOutputLength?: number;
  toolOutputPreview?: string;
}

interface PromptDebugMessage {
  role: string;
  parts: PromptDebugPart[];
}

interface PromptDebugEntry {
  stage: string;
  messageCount: number;
  messages: PromptDebugMessage[];
}

export interface TraceBenchmarkReport {
  snapshots: number;
  totalBaselineTokens: number;
  totalGovernorTokens: number;
  peakBaselineTokens: number;
  peakGovernorTokens: number;
  snapshotsOver60kBaseline: number;
  snapshotsOver60kGovernor: number;
  tokenReductionPct: number;
}

export interface TraceSessionMetrics {
  snapshots: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  finalActiveTokens: number;
  peakTokens: number;
  toolOutputShare: number;
  turnsBeforePressure: number;
  repeatedWorkCount: number;
  forgottenDecisionCount: number;
  continuitySurvived: boolean;
  finalBuildTestResult: string;
}

export interface CapturedTraceBenchmarkReport {
  baseline: TraceSessionMetrics;
  governor: TraceSessionMetrics;
  tokenReductionPct: number;
}

const CONFIG: ContextCompilerConfig = {
  enabled: true,
  modes: { cheap: 35_000, normal: 60_000, deep: 100_000 },
  defaultMode: 'normal',
  recentTurnWindow: 3,
  statusInjection: true,
  statusPlacement: 'end',
  statusVerbosity: 'compact',
  logEnabled: false,
  logSummaryRetentionDays: null,
  logDetailsRetentionDays: 30,
  storeRawCompressedContent: false,
};

function syntheticText(length: number): string {
  return 'x'.repeat(Math.max(0, length));
}

function partText(part: PromptDebugPart): string {
  const preview = part.type === 'tool' ? part.toolOutputPreview : part.textPreview;
  const length = part.type === 'tool' ? part.toolOutputLength : part.textLength;
  if (preview && typeof length === 'number' && preview.length < length) {
    return preview + syntheticText(length - preview.length);
  }
  if (preview) return preview;
  return syntheticText(part.type === 'tool' ? (part.toolOutputLength ?? 120) : (part.textLength ?? 40));
}

function toGovernorMessages(entry: PromptDebugEntry) {
  return entry.messages.map((message) => ({
    info: { role: message.role },
    parts: message.parts.map((part) => (
      part.type === 'tool'
        ? { type: 'tool', tool: part.tool ?? 'tool', state: { status: part.stateStatus ?? 'completed', output: partText(part), input: { command: part.tool ?? 'tool' } } }
        : { type: 'text', text: partText(part) }
    )),
  }));
}

function entryTokens(entry: PromptDebugEntry): number {
  return entry.messages.reduce((sum, message) =>
    sum + message.parts.reduce((partSum, part) => partSum + Math.ceil((part.textLength ?? 40) / 4), 0), 0);
}

function parseEntries(path: string): PromptDebugEntry[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as PromptDebugEntry)
    .filter((entry) => entry.stage === 'after-normalization');
}

export function measureTraceSession(path: string, facts?: ScenarioFacts): TraceSessionMetrics {
  const entries = parseEntries(path);
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let peakTokens = 0;
  let finalActiveTokens = 0;
  let toolOutputShare = 0;
  let turnsBeforePressure = entries.length;
  for (let index = 0; index < entries.length; index++) {
    const messages = toGovernorMessages(entries[index]);
    const currentTokens = countTokens(messages);
    totalInputTokens += currentTokens;
    totalOutputTokens += messages
      .filter((message) => message.info.role === 'assistant')
      .reduce((sum, message) => sum + countTokens([message]), 0);
    peakTokens = Math.max(peakTokens, currentTokens);
    finalActiveTokens = currentTokens;
    toolOutputShare = toolShare(messages);
    if (currentTokens > 60_000 && turnsBeforePressure === entries.length) turnsBeforePressure = index + 1;
  }
  const lastMessages = entries.length > 0 ? toGovernorMessages(entries[entries.length - 1]) : [];
  const continuity = facts ? evaluateContinuity(lastMessages, facts) : {
    repeatedWorkCount: 0,
    forgottenDecisionCount: 0,
    continuitySurvived: false,
    finalBuildTestResult: 'continuity not measured',
  };
  return {
    snapshots: entries.length,
    totalInputTokens,
    totalOutputTokens,
    finalActiveTokens,
    peakTokens,
    toolOutputShare,
    turnsBeforePressure,
    ...continuity,
  };
}

export function compareTraceSessions(
  baselinePath: string,
  governorPath: string,
  facts?: ScenarioFacts,
): CapturedTraceBenchmarkReport {
  const baseline = measureTraceSession(baselinePath, facts);
  const governor = measureTraceSession(governorPath, facts);
  return {
    baseline,
    governor,
    tokenReductionPct: baseline.totalInputTokens > 0
      ? ((baseline.totalInputTokens - governor.totalInputTokens) / baseline.totalInputTokens) * 100
      : 0,
  };
}

export function runTraceBenchmark(path: string): TraceBenchmarkReport {
  const entries = parseEntries(path);
  const governor = new AdaptiveContextGovernor(CONFIG, DEFAULT_GOVERNOR_CONFIG);
  let totalBaselineTokens = 0;
  let totalGovernorTokens = 0;
  let peakBaselineTokens = 0;
  let peakGovernorTokens = 0;
  let snapshotsOver60kBaseline = 0;
  let snapshotsOver60kGovernor = 0;

  for (const entry of entries) {
    const baseline = entryTokens(entry);
    const messages = toGovernorMessages(entry);
    const governed = governor.govern(messages, 'balanced').metricsAfter.totalTokens;
    totalBaselineTokens += baseline;
    totalGovernorTokens += governed;
    peakBaselineTokens = Math.max(peakBaselineTokens, baseline);
    peakGovernorTokens = Math.max(peakGovernorTokens, governed);
    if (baseline > 75_000) snapshotsOver60kBaseline++;
    if (governed > 75_000) snapshotsOver60kGovernor++;
  }

  return {
    snapshots: entries.length,
    totalBaselineTokens,
    totalGovernorTokens,
    peakBaselineTokens,
    peakGovernorTokens,
    snapshotsOver60kBaseline,
    snapshotsOver60kGovernor,
    tokenReductionPct: totalBaselineTokens > 0
      ? ((totalBaselineTokens - totalGovernorTokens) / totalBaselineTokens) * 100
      : 0,
  };
}

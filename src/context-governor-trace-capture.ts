import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AdaptiveContextGovernor } from './context-governor.js';
import { buildScenario, clone, type BenchmarkMessage } from './context-governor-benchmark-fixtures.js';
import { DEFAULT_GOVERNOR_CONFIG } from './context-governor-profiles.js';
import { writePromptDebugLog } from './prompt-debug-log.js';
import type { ContextCompilerConfig } from './types.js';

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

const FACT_MESSAGE_COUNT = 7;
const TURN_MESSAGE_COUNT = 3;

function tracePath(dir: string): string {
  return join(dir, '.opencode', 'prompt-debug', 'messages-transform.jsonl');
}

function resetTraceDir(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function seedFacts(messages: BenchmarkMessage[]): BenchmarkMessage[] {
  return clone(messages.slice(0, FACT_MESSAGE_COUNT));
}

function appendTurn(active: BenchmarkMessage[], messages: BenchmarkMessage[], turn: number): void {
  const start = FACT_MESSAGE_COUNT + turn * TURN_MESSAGE_COUNT;
  const next = messages.slice(start, start + TURN_MESSAGE_COUNT).map(clone);
  active.push(...next);
}

export function captureTraceSession(dir: string, turns: number, mode: 'baseline' | 'governor'): string {
  const { messages } = buildScenario(turns);
  const active = seedFacts(messages);
  const governor = new AdaptiveContextGovernor(CONFIG, DEFAULT_GOVERNOR_CONFIG);
  resetTraceDir(dir);
  for (let turn = 0; turn < turns; turn++) {
    appendTurn(active, messages, turn);
    if (mode === 'governor') governor.govern(active, 'balanced');
    writePromptDebugLog(dir, 'after-normalization', active as unknown as Array<Record<string, unknown>>, {
      phase32Mode: mode,
      turn: turn + 1,
    });
  }
  return tracePath(dir);
}

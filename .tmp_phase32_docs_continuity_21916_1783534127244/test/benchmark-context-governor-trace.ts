import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildScenario } from '../src/context-governor-benchmark-fixtures.js';
import { captureTraceSession } from '../src/context-governor-trace-capture.js';
import {
  compareTraceSessions,
  measureTraceSession,
  runTraceBenchmark,
} from '../src/context-governor-trace.js';

const workspaceTrace = '.opencode/prompt-debug/messages-transform.jsonl';
const artifactRoot = '.tmp/phase32-trace-benchmark';
const baselineDir = join(artifactRoot, 'baseline');
const governorDir = join(artifactRoot, 'governor');
const facts = buildScenario(240).facts;

rmSync(artifactRoot, { recursive: true, force: true });
const baselinePath = captureTraceSession(baselineDir, 240, 'baseline');
const governorPath = captureTraceSession(governorDir, 240, 'governor');
const captured = compareTraceSessions(baselinePath, governorPath, facts);

console.log(`captured_baseline_tokens=${captured.baseline.totalInputTokens}`);
console.log(`captured_governor_tokens=${captured.governor.totalInputTokens}`);
console.log(`captured_peak_baseline=${captured.baseline.peakTokens}`);
console.log(`captured_peak_governor=${captured.governor.peakTokens}`);
console.log(`captured_pressure_turn_baseline=${captured.baseline.turnsBeforePressure}`);
console.log(`captured_pressure_turn_governor=${captured.governor.turnsBeforePressure}`);
console.log(`captured_tool_share_baseline=${captured.baseline.toolOutputShare.toFixed(3)}`);
console.log(`captured_tool_share_governor=${captured.governor.toolOutputShare.toFixed(3)}`);
console.log(`captured_reduction_pct=${captured.tokenReductionPct.toFixed(1)}`);
console.log(`captured_continuity=${captured.governor.continuitySurvived}`);
console.log(`captured_build_state=${captured.governor.finalBuildTestResult}`);

if (!existsSync(workspaceTrace)) {
  console.log('trace_file_missing=true');
  process.exit(0);
}

const measured = measureTraceSession(workspaceTrace);
const replayed = runTraceBenchmark(workspaceTrace);
console.log(`workspace_trace_snapshots=${measured.snapshots}`);
console.log(`workspace_trace_tokens=${measured.totalInputTokens}`);
console.log(`workspace_trace_peak=${measured.peakTokens}`);
console.log(`workspace_trace_pressure_turn=${measured.turnsBeforePressure}`);
console.log(`workspace_replay_governor_tokens=${replayed.totalGovernorTokens}`);
console.log(`workspace_replay_reduction_pct=${replayed.tokenReductionPct.toFixed(1)}`);

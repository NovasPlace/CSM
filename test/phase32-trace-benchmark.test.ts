import assert from 'node:assert/strict';
import test from 'node:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildScenario } from '../src/context-governor-benchmark-fixtures.js';
import { captureTraceSession } from '../src/context-governor-trace-capture.js';
import { compareTraceSessions } from '../src/context-governor-trace.js';

test('captured trace benchmark shows governor token reduction under pressure', () => {
  const root = '.tmp/phase32-trace-test';
  rmSync(root, { recursive: true, force: true });
  const facts = buildScenario(220).facts;
  const baseline = captureTraceSession(join(root, 'baseline'), 220, 'baseline');
  const governor = captureTraceSession(join(root, 'governor'), 220, 'governor');
  const report = compareTraceSessions(baseline, governor, facts);
  assert.ok(report.baseline.peakTokens > 60_000);
  assert.ok(report.governor.peakTokens <= 60_000);
  assert.ok(report.tokenReductionPct > 40);
  assert.equal(report.governor.continuitySurvived, true);
});

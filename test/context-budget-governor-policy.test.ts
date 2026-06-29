import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { ContextBudgetGovernor } from '../src/context-budget-governor.js';
import { EvidenceVault } from '../src/evidence-vault.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'csm-budget-governor-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function governor(): ContextBudgetGovernor {
  return new ContextBudgetGovernor(new EvidenceVault({ rootDir: tempDir }));
}

describe('ContextBudgetGovernor policy', () => {
  it('distills normal shell output and keeps raw evidence outside prompt', async () => {
    const result = await governor().packageShellOutput({
      command: 'npm test',
      cwd: process.cwd(),
      exitCode: 0,
      stdout: Array.from({ length: 120 }, (_, index) => `pass ${index}`).join('\n'),
      touchedFiles: ['src/context-budget-governor.ts'],
      latestUserText: 'run test proof',
    });

    assert.equal(result.decision.toolOutputMode, 'distilled');
    assert.equal(result.decision.ruleMode, 'load_triggered_rules');
    assert.deepEqual(result.decision.ruleTriggers, ['verification']);
    assert.match(result.promptPayload, /evidence_ref:/);
    assert.match(result.promptPayload, /tokens_avoided:/);
    assert.doesNotMatch(result.promptPayload, /pass 0\npass 1\npass 2/);
    assert.equal((result.distilled?.tokensAvoided ?? 0) > 0, true);
  });

  it('shows raw output for Mayday-protected failures', async () => {
    const result = await governor().packageShellOutput({
      command: 'npm test',
      cwd: process.cwd(),
      exitCode: 1,
      stdout: 'not ok\nError: broken verification',
      stderr: 'stack line 1',
      isMayday: true,
      latestUserText: 'mayday verification failed',
    });

    assert.equal(result.decision.toolOutputMode, 'raw');
    assert.equal(result.decision.verificationLevel, 'halt_for_mayday');
    assert.match(result.promptPayload, /stdout:\nnot ok/);
    assert.match(result.promptPayload, /stderr:\nstack line 1/);
    assert.equal(result.distilled, undefined);
  });

  it('summarizes doc-only churn when a doc summary exists', () => {
    const decision = governor().decide({
      touchedFiles: ['docs/SYSTEM_MAP.md', 'docs/ARCHITECTURE.md'],
      docSummaryAvailable: true,
    });

    assert.equal(decision.docContextMode, 'summary');
    assert.equal(decision.ruleMode, 'core_only');
  });

  it('uses focused-first verification until final proof is requested', () => {
    const normal = governor().decide({
      touchedFiles: ['src/context-budget-governor.ts'],
    });
    const finalProof = governor().decide({
      touchedFiles: ['src/context-budget-governor.ts'],
      finalProofRequired: true,
    });

    assert.equal(normal.verificationLevel, 'targeted_first');
    assert.deepEqual(normal.nextChecks, ['targeted test for touched files']);
    assert.equal(finalProof.verificationLevel, 'full_now');
    assert.deepEqual(finalProof.nextChecks, [
      'targeted test for touched files',
      'build',
      'typecheck',
      'full test suite',
    ]);
  });
});

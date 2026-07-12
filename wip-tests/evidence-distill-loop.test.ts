import { strict as assert } from 'node:assert';
import { describe, it, before, after } from 'node:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { EvidenceVault } from '../src/evidence-vault.js';
import { ContextBudgetGovernor } from '../src/context-budget-governor.js';
import { maybeDistillInPlace } from '../src/hooks/tool-execute-memory.js';
import type { PluginConfig } from '../src/types.js';

function makeCtx(overrides: Partial<PluginConfig> = {}): {
  ctx: unknown;
  vault: EvidenceVault;
  tmpRoot: string;
} {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'ev-distill-'));
  const evidenceRoot = join(tmpRoot, 'artifacts', 'evidence');
  const vault = new EvidenceVault({ rootDir: evidenceRoot });

  const ctx = {
    directory: tmpRoot,
    config: { evidenceDistillation: { enabled: true } },
    database: null,
    memoryManager: null,
  };
  return { ctx, vault, tmpRoot };
}

describe('Evidence distillation loop (Phase 1.2)', () => {
  let tmpRoot: string;

  before(() => { tmpRoot = mkdtempSync(join(tmpdir(), 'ev-distill-suite-')); });
  after(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

  it('replaces large bash output with distilled payload containing evidence_ref', async () => {
    const { ctx } = makeCtx();
    const longOutput = 'line\n'.repeat(500); // ~2500 chars, well above 1200 threshold

    const output = {
      title: 'bash: echo',
      output: longOutput,
      metadata: { exitCode: 0 },
    };

    await maybeDistillInPlace(
      ctx as never,
      { tool: 'bash', sessionID: 'test-sid', callID: 'call-1', args: { command: 'echo test' } },
      output,
      'test-sid',
    );

    assert.notEqual(output.output, longOutput, 'output should have been replaced');
    assert.ok(output.output.length < longOutput.length, 'distilled should be shorter');
    assert.match(output.output, /evidence_ref:/, 'distilled payload should contain evidence_ref');
  });

  it('preserves output verbatim when finalProofRequired is true (npm test)', async () => {
    const { ctx } = makeCtx();
    const testOutput = 'test output\n'.repeat(200) + '1 failing\n';

    const output = {
      title: 'bash: npm test',
      output: testOutput,
      metadata: { exitCode: 1 },
    };

    await maybeDistillInPlace(
      ctx as never,
      { tool: 'bash', sessionID: 'test-sid', callID: 'call-2', args: { command: 'npm test' } },
      output,
      'test-sid',
    );

    // finalProofRequired should trigger raw mode — output preserved
    assert.equal(output.output, testOutput, 'verification output must be preserved verbatim');
  });

  it('preserves output verbatim when output is small (< 1200 chars)', async () => {
    const { ctx } = makeCtx();
    const shortOutput = 'hello\n';

    const output = {
      title: 'bash: echo',
      output: shortOutput,
      metadata: { exitCode: 0 },
    };

    await maybeDistillInPlace(
      ctx as never,
      { tool: 'bash', sessionID: 'test-sid', callID: 'call-3', args: { command: 'echo hello' } },
      output,
      'test-sid',
    );

    assert.equal(output.output, shortOutput, 'small output should not be distilled');
  });

  it('skips non-budget tools (e.g., edit)', async () => {
    const { ctx } = makeCtx();
    const editOutput = 'file edited\n'.repeat(200);

    const output = {
      title: 'edit: file.ts',
      output: editOutput,
      metadata: {},
    };

    await maybeDistillInPlace(
      ctx as never,
      { tool: 'edit', sessionID: 'test-sid', callID: 'call-4', args: { filePath: 'test.ts' } },
      output,
      'test-sid',
    );

    assert.equal(output.output, editOutput, 'edit tool should not be distilled');
  });

  it('full closed loop: bash → distill → evidence_fetch recovers original', async () => {
    const { ctx, vault } = makeCtx();
    const originalContent = Array.from({ length: 100 }, (_, i) => `line ${i}: data`).join('\n');

    const output = {
      title: 'bash: seq',
      output: originalContent,
      metadata: { exitCode: 0 },
    };

    await maybeDistillInPlace(
      ctx as never,
      { tool: 'bash', sessionID: 'test-sid', callID: 'call-5', args: { command: 'echo data' } },
      output,
      'test-sid',
    );

    // Extract evidence_ref from distilled payload
    const refMatch = output.output.match(/evidence_ref:\s*(\S+)/);
    assert.ok(refMatch, 'distilled payload must contain evidence_ref');
    const evidenceRef = refMatch[1];

    // Fetch via vault.safeRead
    const record = await vault.safeRead(evidenceRef);
    assert.equal(record.stdout, originalContent, 'recovered content must match original');
  });

  it('never mutates output on distillation failure (safety-first)', async () => {
    // Create a FILE where a directory is expected — mkdir will fail with ENOTDIR
    const blockDir = mkdtempSync(join(tmpdir(), 'ev-block-'));
    const blocker = join(blockDir, 'blocker');
    writeFileSync(blocker, 'i am a file, not a directory');
    const badCtx = {
      // EvidenceVault will try mkdir(blocker/artifacts/evidence, recursive: true)
      // but `blocker` is a file — mkdir will throw ENOTDIR
      directory: blocker,
      config: { evidenceDistillation: { enabled: true } },
      database: null,
      memoryManager: null,
    };

    const original = 'line\n'.repeat(500);
    const output = {
      title: 'bash: echo',
      output: original,
      metadata: { exitCode: 0 },
    };

    await maybeDistillInPlace(
      badCtx as never,
      { tool: 'bash', sessionID: 'test-sid', callID: 'call-6', args: { command: 'echo test' } },
      output,
      'test-sid',
    );

    // On failure, output should be preserved
    assert.equal(output.output, original, 'distillation failure must not eat original output');
    rmSync(blockDir, { recursive: true, force: true });
  });
});
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceVault } from '../src/evidence-vault.js';
import { ToolOutputDistiller } from '../src/tool-output-distiller.js';

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'csm-evidence-'));
}

describe('EvidenceVault', () => {
  it('stores and reads raw command evidence', async () => {
    const root = await tempRoot();
    try {
      const vault = new EvidenceVault({ rootDir: root, now: () => new Date('2026-06-29T00:00:00Z') });
      const stored = await vault.store({
        command: 'npm.cmd test',
        cwd: root,
        exitCode: 1,
        stdout: 'pass\nfail',
        stderr: 'AssertionError: nope',
      });
      const read = await vault.read(stored.evidenceRef);
      assert.equal(read.command, 'npm.cmd test');
      assert.equal(read.exitCode, 1);
      assert.equal(read.stderr, 'AssertionError: nope');
      assert.ok(read.rawTokens > 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('EvidenceVault retention', () => {
  it('prunes evidence files older than maxAgeDays', async () => {
    const root = await tempRoot();
    try {
      const oldDate = new Date('2025-01-01T00:00:00Z');
      const newDate = new Date('2026-06-29T00:00:00Z');
      const vault = new EvidenceVault({ rootDir: root, now: () => newDate, maxAgeDays: 30 });

      await vault.store({ command: 'old-cmd', cwd: root, exitCode: 0, stdout: 'old', startedAt: oldDate.toISOString(), endedAt: oldDate.toISOString() });

      const { promises: fsp } = await import('fs');
      const files = await fsp.readdir(root);
      for (const file of files) {
        if (file.includes('old-cmd')) {
          await fsp.utimes(join(root, file), oldDate, oldDate);
        }
      }

      await vault.store({ command: 'new-cmd', cwd: root, exitCode: 0, stdout: 'new' });

      const result = await vault.pruneOldEvidence();
      assert.ok(result.deleted >= 1, `expected at least 1 deletion, got ${result.deleted}`);
      assert.ok(result.remaining >= 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps recent evidence under maxAgeDays', async () => {
    const root = await tempRoot();
    try {
      const now = new Date('2026-06-29T00:00:00Z');
      const vault = new EvidenceVault({ rootDir: root, now: () => now, maxAgeDays: 30 });
      await vault.store({ command: 'recent-cmd', cwd: root, exitCode: 0, stdout: 'recent' });
      const result = await vault.pruneOldEvidence();
      assert.equal(result.deleted, 0);
      assert.ok(result.remaining >= 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('ToolOutputDistiller', () => {
  it('keeps failure lines while storing full raw output in the vault', async () => {
    const root = await tempRoot();
    try {
      const vault = new EvidenceVault({ rootDir: root, now: () => new Date('2026-06-29T00:00:00Z') });
      const distiller = new ToolOutputDistiller(vault);
      const noisy = Array.from({ length: 80 }, (_, i) => `ok ${i}`).join('\n');
      const result = await distiller.distill({
        command: 'npx tsx --test test/demo.test.ts',
        cwd: root,
        exitCode: 1,
        stdout: `${noisy}\n✖ failing test\nAssertionError: expected true`,
        stderr: 'at TestContext.<anonymous> (demo.test.ts:4:1)',
      });
      const raw = await vault.read(result.evidenceRef);
      assert.equal(result.status, 'failure');
      assert.ok(result.failureLines.some((line) => line.includes('AssertionError')));
      assert.ok(result.summary.includes('failure_lines'));
      assert.ok(raw.stdout.includes('ok 79'));
      assert.ok(result.tokensAvoided > 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('collapses success output to tail and reports prompt tokens', async () => {
    const root = await tempRoot();
    try {
      const distiller = new ToolOutputDistiller(new EvidenceVault({ rootDir: root }));
      const result = await distiller.distill({
        command: 'npm.cmd run build',
        cwd: root,
        exitCode: 0,
        stdout: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'),
      });
      assert.equal(result.status, 'success');
      assert.equal(result.failureLines.length, 0);
      assert.ok(result.tail.includes('line 39'));
      assert.ok(result.promptTokens < result.rawTokens);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

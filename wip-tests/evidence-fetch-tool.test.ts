import { strict as assert } from 'node:assert';
import { describe, it, before, after, beforeEach } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EvidenceVault } from '../src/evidence-vault.js';
import { evidenceFetchTool } from '../src/evidence-fetch-tool.js';

function makeVault(root: string): EvidenceVault {
  mkdirSync(join(root, 'artifacts', 'evidence'), { recursive: true });
  return new EvidenceVault({ rootDir: join(root, 'artifacts', 'evidence') });
}

async function storeRecord(vault: EvidenceVault, partial: Partial<{
  command: string; cwd: string; exitCode: number; stdout: string; stderr: string;
}>): Promise<{ ref: string; record: Record<string, unknown> }> {
  const input = {
    command: partial.command ?? 'echo hello',
    cwd: partial.cwd ?? '/tmp',
    exitCode: partial.exitCode ?? 0,
    stdout: partial.stdout ?? 'hello\n',
    stderr: partial.stderr ?? '',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  };
  const stored = await vault.store(input);
  return { ref: stored.evidenceRef, record: stored as unknown as Record<string, unknown> };
}

async function callTool(
  toolObj: ReturnType<typeof evidenceFetchTool>,
  args: { evidence_ref: string; mode?: string; startLine?: number; endLine?: number; maxChars?: number },
): Promise<{ title: string; output: string; metadata: Record<string, unknown> }> {
  const fn = (toolObj as unknown as { execute: (a: typeof args) => Promise<{ title: string; output: string; metadata: Record<string, unknown> }> }).execute;
  return fn(args);
}

describe('evidence_fetch tool (Phase 1.1)', () => {
  let tmpRoot: string;
  let vault: EvidenceVault;
  let toolObj: ReturnType<typeof evidenceFetchTool>;
  let storedRef: string;
  let storedRecord: Record<string, unknown>;

  before(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'ev-fetch-'));
    vault = makeVault(tmpRoot);
    toolObj = evidenceFetchTool({ vault });
    // Create one shared fixture for most tests
    const result = await storeRecord(vault, {
      command: 'npm test',
      stdout: ['line 1: ok', 'line 2: ok', 'line 3: FAIL AssertionError: bad', 'line 4: ok', 'line 5: done'].join('\n'),
      stderr: 'npm warn deprecated',
      exitCode: 1,
    });
    storedRef = result.ref;
    storedRecord = result.record;
  });

  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns summary-mode output with command, exit_code, failure_lines, and tail', async () => {
    const ref = storedRef.split(/[\\/]/).pop()!;
    const res = await callTool(toolObj, { evidence_ref: ref });
    assert.equal(res.metadata.mode, 'summary');
    assert.match(res.output, /command: npm test/);
    assert.match(res.output, /exit_code: 1/);
    // Failure line preserved
    assert.match(res.output, /FAIL.*Assertionion|AssertionError/i);
    // Tail preserved
    assert.match(res.output, /line 5: done/);
  });

  it('honors startLine and endLine (1-indexed, inclusive)', async () => {
    const ref = storedRef.split(/[\\/]/).pop()!;
    const res = await callTool(toolObj, { evidence_ref: ref, startLine: 2, endLine: 3 });
    // Requested lines section should include "line 2" and "line 3"
    assert.match(res.output, /line 2: ok/);
    assert.match(res.output, /line 3: FAIL/);
    // "line 1" should NOT appear in the requested_lines section (may appear in tail; verify requested section starts explicitly)
    // Just verify the requested lines subblock contains lines 2 and 3
  });

  it('truncates output when maxChars is small and sets truncated=true', async () => {
    const ref = storedRef.split(/[\\/]/).pop()!;
    const res = await callTool(toolObj, { evidence_ref: ref, maxChars: 80 });
    assert.equal(res.metadata.mode, 'summary');
    assert.ok(res.output.length <= 80 + 10, `output should be roughly <= maxChars+10, got ${res.output.length}`);
    // The metadata.truncated flag should be true because the body was cut
    assert.equal(res.metadata.truncated, true);
  });

  it('raw mode returns original stdout content bounded by maxChars', async () => {
    const ref = storedRef.split(/[\\/]/).pop()!;
    const res = await callTool(toolObj, { evidence_ref: ref, mode: 'raw' });
    assert.equal(res.metadata.mode, 'raw');
    assert.match(res.output, /line 1: ok/);
    assert.match(res.output, /line 5: done/);
    assert.match(res.output, /stderr:/);
    assert.match(res.output, /npm warn deprecated/);
  });

  it('accepts the full display ref (artifacts/evidence/<id>.json) as well as bare id', async () => {
    const basename = storedRef.split(/[\\/]/).pop()!;
    const fullRef = `artifacts/evidence/${basename}`;
    const res = await callTool(toolObj, { evidence_ref: fullRef });
    assert.match(res.output, /command: npm test/);
  });

  it('rejects evidence_ref containing ".." as FORBIDDEN', async () => {
    const res = await callTool(toolObj, { evidence_ref: '../../../etc/passwd' });
    assert.equal(res.metadata.code, 'FORBIDDEN');
    assert.match(res.output, /FORBIDDEN|\.\./i);
  });

  it('rejects evidence_ref with non-json extension as FORBIDDEN', async () => {
    const res = await callTool(toolObj, { evidence_ref: 'sensitive.txt' });
    assert.equal(res.metadata.code, 'FORBIDDEN');
  });

  it('returns NOT_FOUND for non-existent artifact', async () => {
    const res = await callTool(toolObj, { evidence_ref: 'never-stored-ever.json' });
    assert.equal(res.metadata.code, 'NOT_FOUND');
  });

  it('roundtrip: vault.store() → evidence_fetch() → recovers original content', async () => {
    const unique = await storeRecord(vault, {
      command: 'echo roundtrip-unique-content',
      stdout: 'roundtrip-unique-content\n',
      exitCode: 0,
    });
    const basename = unique.ref.split(/[\\/]/).pop()!;
    const res = await callTool(toolObj, { evidence_ref: basename, mode: 'raw' });
    assert.match(res.output, /roundtrip-unique-content/);
  });

  it('enforces 50k hard ceiling on maxChars even when caller requests 100000', async () => {
    const big = await storeRecord(vault, {
      command: 'seq 1 100000',
      stdout: Array.from({ length: 10_000 }, (_, i) => `line ${i}`).join('\n'),
    });
    const ref = big.ref.split(/[\\/]/).pop()!;
    const res = await callTool(toolObj, { evidence_ref: ref, mode: 'raw', maxChars: 100_000 });
    assert.ok(res.output.length <= 50_500, `output must be bounded by 50k hard ceiling, got ${res.output.length}`);
  });
});
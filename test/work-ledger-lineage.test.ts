import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  buildLineageManifest,
  contentHash,
  evaluateSurvival,
  patchHash,
} from '../src/work-ledger-lineage.js';
import {
  assertWorkLedgerPathSafe,
  extractWorkLedgerPaths,
  resolveWorkLedgerPath,
} from '../src/work-ledger-files.js';
import { WorkLedger } from '../src/work-ledger.js';

function change(before: string, after: string) {
  const lineageManifest = buildLineageManifest(before, after);
  const beforeHash = contentHash(before);
  const afterHash = contentHash(after);
  return {
    beforeHash,
    afterHash,
    patchHash: patchHash(beforeHash, afterHash, lineageManifest),
    lineageManifest,
  };
}

function current(content: string) {
  return { hash: contentHash(content), content };
}

it('stores changed-line hashes and counts without raw source text', () => {
  const manifest = buildLineageManifest('before\nshared', 'after\nshared');
  assert.equal(manifest.length, 2);
  assert.ok(manifest.every((entry) => /^[a-f0-9]{64}$/.test(entry.hash)));
  assert.ok(!JSON.stringify(manifest).includes('"before"'));
  assert.ok(!JSON.stringify(manifest).includes('"after"'));
});

it('keeps a patch active after unrelated later additions', () => {
  const original = 'base';
  const changed = 'base\nowned-a\nowned-b';
  const result = evaluateSurvival(change(original, changed), current(`${changed}\nunrelated`));
  assert.equal(result.status, 'active');
  assert.equal(result.survivingUnits, result.totalUnits);
});

it('detects partial supersession when only part of a patch survives', () => {
  const result = evaluateSurvival(
    change('base', 'base\nowned-a\nowned-b'),
    current('base\nowned-a\nreplacement'),
  );
  assert.equal(result.status, 'partially_superseded');
  assert.equal(result.survivingUnits, 1);
  assert.equal(result.totalUnits, 2);
  assert.match(result.survivingPatchHash ?? '', /^[a-f0-9]{64}$/);
});

it('detects complete supersession and exact revert', () => {
  const original = 'base';
  const ledgerChange = change(original, 'base\nowned-a\nowned-b');
  assert.equal(evaluateSurvival(ledgerChange, current('base\nreplacement')).status, 'superseded');
  assert.equal(evaluateSurvival(ledgerChange, current(original)).status, 'reverted');
});

it('does not resurrect a terminal historical change', () => {
  const ledgerChange = {
    ...change('base', 'base\nowned'),
    status: 'reverted' as const,
  };
  assert.equal(evaluateSurvival(ledgerChange, current('base\nowned')).status, 'reverted');
});

it('does not transfer partial ownership to a different surviving subset', () => {
  const ledgerChange = change('base', 'base\nowned-x\nowned-y');
  const first = evaluateSurvival(ledgerChange, current('base\nowned-x'));
  const historical = {
    ...ledgerChange,
    status: 'partially_superseded' as const,
    survivingPatchHash: first.survivingPatchHash,
  };
  assert.equal(evaluateSurvival(historical, current('base\nowned-y')).status, 'superseded');
});

it('treats a surviving deletion as active after unrelated edits', () => {
  const result = evaluateSurvival(
    change('base\nremoved-line', 'base'),
    current('base\nunrelated'),
  );
  assert.equal(result.status, 'active');
});

it('extracts multi-file patch paths and rejects root escapes', () => {
  const paths = extractWorkLedgerPaths({
    patch: [
      '*** Update File: src/a.ts',
      '*** Move to: src/moved.ts',
      '*** Add File: src/b.ts',
      '--- a/src/old.ts',
      '+++ b/src/new.ts',
    ].join('\n'),
    files: [{ filePath: 'src/c.ts' }],
    edits: [{ path: 'src/d.ts' }],
  });
  assert.deepEqual(paths, [
    'src/c.ts', 'src/d.ts', 'src/a.ts', 'src/b.ts',
    'src/moved.ts', 'src/old.ts', 'src/new.ts',
  ]);
  assert.throws(
    () => resolveWorkLedgerPath('C:\\workspace', 'C:\\outside\\secret.txt'),
    /escapes project root/,
  );
});

it('rejects an in-root symlink that resolves outside the project', async () => {
  const base = resolve(`.tmp/work-ledger-symlink-${process.pid}`);
  const root = resolve(base, 'root');
  const outside = resolve(base, 'outside');
  const link = resolve(root, 'linked');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(resolve(outside, 'secret.txt'), 'secret');
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await assert.rejects(
      () => assertWorkLedgerPathSafe(root, resolve(link, 'secret.txt')),
      /resolves outside project root/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

it('rejects completion without matching pending provenance', async () => {
  const ledger = new WorkLedger(
    {} as never,
    { enabled: true, maxFileBytes: 1_000_000, captureTimeoutMs: 1_000 },
  );
  await assert.rejects(
    () => ledger.captureAfter({
      runId: 'wrong-run', sessionId: 'session', modelId: 'model',
      toolCallId: 'call', toolName: 'edit', projectRoot: process.cwd(),
      args: { filePath: 'src/a.ts' },
    }),
    /no matching pending capture/,
  );
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

function runLicenseCheck(lockfile?: string) {
  const args = ['scripts/verify-production-licenses.mjs'];
  if (lockfile) args.push('--lockfile', lockfile);
  return spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('commercial supply-chain controls', () => {
  it('accepts only the reviewed production licenses in the committed lockfile', () => {
    const result = runLicenseCheck();
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Production license policy passed for \d+ dependencies/u);
  });

  it('rejects new or missing production license metadata', () => {
    const directory = mkdtempSync(join(tmpdir(), 'csm-license-policy-'));
    const lockfile = join(directory, 'package-lock.json');
    try {
      writeFileSync(lockfile, JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'fixture', version: '1.0.0' },
          'node_modules/copyleft': { version: '1.0.0', license: 'GPL-3.0-only' },
          'node_modules/unknown': { version: '1.0.0' },
          'node_modules/dev-only': { version: '1.0.0', license: 'GPL-3.0-only', dev: true },
        },
      }), 'utf8');
      const result = runLicenseCheck(lockfile);
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.match(result.stderr, /copyleft: unreviewed license expression GPL-3\.0-only/u);
      assert.match(result.stderr, /unknown: missing license metadata/u);
      assert.doesNotMatch(result.stderr, /dev-only/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('pins every external GitHub Action to a full commit SHA', () => {
    const workflowDirectory = join(process.cwd(), '.github', 'workflows');
    for (const filename of readdirSync(workflowDirectory).filter((name) => name.endsWith('.yml'))) {
      const workflow = readFileSync(join(workflowDirectory, filename), 'utf8');
      for (const match of workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)) {
        const reference = match[1];
        if (reference.startsWith('./')) continue;
        assert.match(reference, /@[a-f0-9]{40}$/u, `${filename} has an unpinned action: ${reference}`);
      }
    }
  });

  it('keeps secret exceptions fingerprint-specific and release publishing approval-gated', () => {
    const ignore = readFileSync(join(process.cwd(), '.gitleaksignore'), 'utf8');
    const fingerprints = ignore.split(/\r?\n/u).filter((line) => line && !line.startsWith('#'));
    assert.equal(fingerprints.length, 24);
    assert.equal(new Set(fingerprints).size, fingerprints.length);
    for (const fingerprint of fingerprints) {
      assert.match(fingerprint, /^[a-f0-9]{40}:.+:[a-z0-9-]+:\d+$/u);
    }

    const release = readFileSync(join(process.cwd(), '.github', 'workflows', 'release.yml'), 'utf8');
    assert.match(release, /environment: npm-production/u);
    assert.match(release, /confirm_package:/u);
    assert.match(release, /npm stage publish/u);
    assert.match(release, /attestations: write/u);
    assert.match(release, /sbom-path: \.release\/sbom\.cdx\.json/u);
  });
});

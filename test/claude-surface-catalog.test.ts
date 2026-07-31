import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const validator = join(process.cwd(), 'scripts', 'validate-claude-surface.mjs');
const bundle = join(process.cwd(), 'plugins', 'cross-session-memory');

function runValidator(pluginRoot?: string) {
  const args = [validator];
  if (pluginRoot) args.push('--plugin-root', pluginRoot);
  return spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60_000 });
}

describe('Claude surface catalog', () => {
  it('passes for the shipped bundle', () => {
    const result = runValidator();
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /commands, 3 agents, 3 skills/u);
  });

  it('detects a command declared in the catalog but missing on disk', () => {
    const temp = mkdtempSync(join(tmpdir(), 'csm-surface-'));
    try {
      cpSync(bundle, temp, {
        recursive: true,
        filter: (source) => !source.includes(`${'runtime'}`),
      });
      // Remove an implemented command so the catalog references a missing file.
      rmSync(join(temp, 'commands', 'csm-recall.md'), { force: true });
      const result = runValidator(temp);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /csm-recall.*missing/u);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('detects an undocumented command file not in the catalog', () => {
    const temp = mkdtempSync(join(tmpdir(), 'csm-surface-'));
    try {
      cpSync(bundle, temp, {
        recursive: true,
        filter: (source) => !source.includes(`${'runtime'}`),
      });
      cpSync(join(temp, 'commands', 'csm-goals.md'), join(temp, 'commands', 'csm-rogue.md'));
      const result = runValidator(temp);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /undocumented command/u);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

describe('SQLite plugin lifecycle', () => {
  it('starts, injects a first-turn prompt, and disposes without persistence errors', () => {
    const tempDir = join(process.cwd(), '.tmp', `sqlite-lifecycle-${process.pid}`);
    const dbPath = join(tempDir, 'csm.sqlite');
    const statsPath = join(tempDir, 'stats.json');
    const probePath = join(process.cwd(), 'test', 'sqlite-plugin-lifecycle-probe.mjs');
    mkdirSync(tempDir, { recursive: true });

    try {
      const { CSM_DATABASE_PROVIDER: _provider, ...baseEnv } = process.env;
      const result = spawnSync(process.execPath, [probePath, tempDir], {
        cwd: tempDir,
        encoding: 'utf8',
        env: {
          ...baseEnv,
          CSM_SQLITE_PATH: dbPath,
          OPENCODE_CSM_STATS_PATH: statsPath,
        },
      });
      const output = `${result.stdout}\n${result.stderr}`;
      assert.equal(result.status, 0, output);
      assert.doesNotMatch(output, /SqliteError|no such table|Failed to write stats|Context injection error|Tool tracking error/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

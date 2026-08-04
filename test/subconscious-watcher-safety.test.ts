import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SubconsciousWatcher } from '../dist/subconscious.js';
import type { MemoryManager } from '../src/memory-manager.js';

const cleanupPaths: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe('SubconsciousWatcher scan safety', () => {
  it('never overlaps interval scans', async () => {
    const watcher = new SubconsciousWatcher({} as MemoryManager, 0.001);
    let concurrent = 0;
    let maxConcurrent = 0;
    const internals = watcher as unknown as { watchFiles: () => Promise<void> };
    internals.watchFiles = async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      concurrent -= 1;
    };

    watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 55));
    watcher.stop();
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(maxConcurrent, 1);
  });

  it('keeps directory discovery state separate from watched roots and does not auto-document the initial tree', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'csm-subconscious-'));
    cleanupPaths.push(root);
    await mkdir(path.join(root, 'existing'));

    const watcher = new SubconsciousWatcher({} as MemoryManager, 30);
    let documented = 0;
    const internals = watcher as unknown as {
      watchFiles: () => Promise<void>;
      handleNewDirectory: () => Promise<void>;
      watchedPaths: Map<string, Date>;
    };
    internals.handleNewDirectory = async () => { documented += 1; };

    watcher.watchPath(root);
    await internals.watchFiles();

    assert.equal(documented, 0);
    assert.deepEqual([...internals.watchedPaths.keys()], [root]);

    await mkdir(path.join(root, 'new-directory'));
    await internals.watchFiles();

    assert.equal(documented, 1);
    assert.deepEqual([...internals.watchedPaths.keys()], [root]);
  });
});

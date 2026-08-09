import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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

describe('SubconsciousWatcher host-safety guards', () => {
  it('refuses to watch roots inside host state trees (hermes app-data, pip cache)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'csm-subconscious-'));
    cleanupPaths.push(root);
    const hermesRoot = path.join(root, 'AppData', 'Local', 'hermes');
    const pipRoot = path.join(root, 'AppData', 'Local', 'pip');
    await mkdir(hermesRoot, { recursive: true });
    await mkdir(pipRoot, { recursive: true });

    const watcher = new SubconsciousWatcher({} as MemoryManager, 30);
    watcher.watchPath(hermesRoot);
    watcher.watchPath(pipRoot);

    const internals = watcher as unknown as { watchedPaths: Map<string, Date> };
    assert.equal(internals.watchedPaths.size, 0);

    // A normal project root is still accepted
    watcher.watchPath(root);
    assert.equal(internals.watchedPaths.size, 1);
  });

  it('never auto-documents inside cache/build/log trees', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'csm-subconscious-'));
    cleanupPaths.push(root);
    await mkdir(path.join(root, 'Library'), { recursive: true });
    await mkdir(path.join(root, 'cache'), { recursive: true });
    await mkdir(path.join(root, 'logs'), { recursive: true });

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

    // New directories appearing inside excluded trees are never discovered
    await mkdir(path.join(root, 'Library', 'PackageCache'), { recursive: true });
    await mkdir(path.join(root, 'cache', 'delegation', 'live'), { recursive: true });
    await mkdir(path.join(root, 'logs', 'web'), { recursive: true });
    await internals.watchFiles();

    assert.equal(documented, 0);
  });

  it('does not record memories for READMEs the watcher auto-generated', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'csm-subconscious-'));
    cleanupPaths.push(root);

    const generatedReadme = path.join(root, 'README.md');
    await writeFile(
      generatedReadme,
      '# some-dir\n\nAuto-generated documentation for `some-dir`\n\n## Overview\nThis directory was detected by the Cross-Session Memory plugin\'s subconscious watcher.\n',
    );
    const handWritten = path.join(root, 'notes.md');
    await writeFile(handWritten, '# real notes\n');

    let saved = 0;
    const memoryManager = {
      saveMemory: async () => { saved += 1; },
    } as unknown as MemoryManager;
    const watcher = new SubconsciousWatcher(memoryManager, 30);

    await watcher.captureFileChange({
      filePath: generatedReadme,
      eventType: 'modified',
      timestamp: new Date(),
    });
    assert.equal(saved, 0);

    // A hand-written file (no signature) still captures normally
    await watcher.captureFileChange({
      filePath: handWritten,
      eventType: 'modified',
      timestamp: new Date(),
    });
    assert.equal(saved, 1);
  });

  it('does not record memories for AGENTBOOK_STATE.md the system regenerates', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'csm-subconscious-'));
    cleanupPaths.push(root);

    const agentBookState = path.join(root, 'AGENTBOOK_STATE.md');
    await writeFile(agentBookState, '# AgentBook — Current State\r\n\r\n## Project\r\ncross-session-memory\r\n');

    let saved = 0;
    const memoryManager = {
      saveMemory: async () => { saved += 1; },
    } as unknown as MemoryManager;
    const watcher = new SubconsciousWatcher(memoryManager, 30);

    await watcher.captureFileChange({
      filePath: agentBookState,
      eventType: 'modified',
      timestamp: new Date(),
    });
    assert.equal(saved, 0);

    // A sibling, genuinely user-authored file still captures normally
    const notes = path.join(root, 'AGENTS.md');
    await writeFile(notes, '# working agreements\n');
    await watcher.captureFileChange({
      filePath: notes,
      eventType: 'modified',
      timestamp: new Date(),
    });
    assert.equal(saved, 1);
  });
});

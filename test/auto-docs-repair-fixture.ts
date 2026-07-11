import { afterEach, beforeEach } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearPendingUpdates, resetInitializedProjects } from '../src/hooks/auto-docs.js';
import { clearAllFlushTimers } from '../src/hooks/tool-execute-memory.js';
import type { PluginContext } from '../src/plugin-context.js';

const TMP_BASE = join(tmpdir(), 'csm-autodocs-repair-');
export const dirsToClean: string[] = [];

export function installAutoDocsTestHooks(): void {
  beforeEach(() => {
    clearPendingUpdates();
    resetInitializedProjects();
  });
  afterEach(() => {
    clearAllFlushTimers();
    clearPendingUpdates();
    resetInitializedProjects();
    for (const directory of dirsToClean) cleanupDir(directory);
    dirsToClean.length = 0;
  });
}

export function makeTempDir(label: string): string {
  return mkdtempSync(TMP_BASE + label + '-');
}

export function makeSourceFile(directory: string, relativePath: string, content: string): void {
  const fullPath = join(directory, relativePath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
}

export function makePluginContext(directory: string): PluginContext {
  return {
    directory,
    config: { autoDocs: { maxEntryLength: 500, maxChangelogEntriesPerSession: 50 } },
    state: {},
    sessionId: 'test-session',
  } as unknown as PluginContext;
}

export function readDocIfExists(directory: string, name: string): string {
  const path = join(directory, 'docs', name);
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

function cleanupDir(directory: string): void {
  try { rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ }
}

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { listMemoriesOp, searchMemoriesOp } from '../dist/bridge-ops.js';

describe('bridge ops project fallback', () => {
  it('falls back from project to legacy for listMemoriesOp', async () => {
    const calls: string[] = [];
    const projects: Array<string | undefined> = [];
    const deps = {
      memoryManager: {
        async listMemories(input: { searchMode?: string; projectId?: string }) {
          calls.push(input.searchMode ?? 'unset');
          projects.push(input.projectId);
          return input.searchMode === 'legacy'
            ? [{ id: 1, content: 'legacy memory' }]
            : [];
        },
      },
      primingEngine: {},
      contextRecall: {},
      contextCompactor: {},
    } as any;

    const result = await listMemoriesOp(deps, { projectId: 'cross-session-memory' }, {});

    assert.equal(result.length, 1);
    assert.deepEqual(calls, ['project', 'legacy']);
    assert.deepEqual(projects, ['cross-session-memory', undefined]);
  });

  it('does not cross the project boundary when project and legacy are empty', async () => {
    const calls: string[] = [];
    const deps = {
      memoryManager: {
        async searchMemories(input: { searchMode?: string }) {
          calls.push(input.searchMode ?? 'unset');
          return input.searchMode === 'global'
            ? [{ memory: { id: 7, content: 'global memory' }, score: 0.9 }]
            : [];
        },
      },
      primingEngine: {
        async cascadeFromMultiple() {
          return { memories: [] };
        },
      },
      contextRecall: {},
      contextCompactor: {},
    } as any;

    const result = await searchMemoriesOp(
      deps,
      { query: 'phases', projectId: 'cross-session-memory', limit: 5 },
      {},
    );

    assert.equal(result.results.length, 0);
    assert.deepEqual(calls, ['project', 'legacy']);
  });

  it('preserves partial project results without widening the search', async () => {
    const calls: string[] = [];
    const deps = {
      memoryManager: {
        async searchMemories(input: { searchMode?: string }) {
          calls.push(input.searchMode ?? 'unset');
          return [{ memory: { id: 3, content: 'project memory' }, score: 0.8 }];
        },
      },
      primingEngine: { async cascadeFromMultiple() { return { memories: [] }; } },
      contextRecall: {},
      contextCompactor: {},
    } as any;

    const result = await searchMemoriesOp(
      deps,
      { query: 'phases', projectId: 'cross-session-memory', limit: 5 },
      {},
    );

    assert.equal(result.results[0].memory.id, 3);
    assert.deepEqual(calls, ['project']);
  });

  it('allows an explicitly global search', async () => {
    const calls: string[] = [];
    const deps = {
      memoryManager: {
        async searchMemories(input: { searchMode?: string }) {
          calls.push(input.searchMode ?? 'unset');
          return [{ memory: { id: 7, content: 'global memory' }, score: 0.9 }];
        },
      },
      primingEngine: { async cascadeFromMultiple() { return { memories: [] }; } },
      contextRecall: {},
      contextCompactor: {},
    } as any;

    const result = await searchMemoriesOp(
      deps,
      { query: 'phases', searchMode: 'global', limit: 5 },
      {},
    );

    assert.equal(result.results[0].memory.id, 7);
    assert.deepEqual(calls, ['global']);
  });
});

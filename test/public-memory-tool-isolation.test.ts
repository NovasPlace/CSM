import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  memoryDeleteTool,
  memoryListTool,
  memorySearchTool,
} from '../dist/tools.js';

describe('public memory tools enforce their bound project', () => {
  it('forces search into the registered project scope', async () => {
    const searches: Array<Record<string, unknown>> = [];
    const memoryManager = {
      async searchMemories(input: Record<string, unknown>) {
        searches.push(input);
        return [];
      },
    } as any;
    const primingEngine = {
      async cascadeFromMultiple() {
        return { memories: [] };
      },
    } as any;

    const definition = memorySearchTool(memoryManager, primingEngine, 'project-a');
    await definition.execute({ query: 'shared secret' }, { sessionID: 'session-a' });

    assert.equal(searches[0]?.projectId, 'project-a');
    assert.equal(searches[0]?.searchMode, 'project');
  });

  it('ignores caller project selection by exposing only the bound list scope', async () => {
    const lists: Array<Record<string, unknown>> = [];
    const memoryManager = {
      async listMemories(input: Record<string, unknown>) {
        lists.push(input);
        return [];
      },
    } as any;

    const definition = memoryListTool(memoryManager, 'project-a');
    assert.equal('projectId' in definition.args, false);
    await definition.execute({}, { sessionID: 'session-a' });

    assert.equal(lists[0]?.projectId, 'project-a');
    assert.equal(lists[0]?.searchMode, 'project');
  });

  it('passes the bound project to destructive deletion', async () => {
    const calls: Array<{ id: number; projectId: string }> = [];
    const memoryManager = {
      async deleteMemory(id: number, projectId: string) {
        calls.push({ id, projectId });
        return false;
      },
    } as any;

    const definition = memoryDeleteTool(memoryManager, 'project-a');
    await definition.execute({ id: 41 }, { sessionID: 'session-a' });

    assert.deepEqual(calls, [{ id: 41, projectId: 'project-a' }]);
  });
});

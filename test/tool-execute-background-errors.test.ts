import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { autoDistill } from '../src/hooks/tool-execute-memory.js';
import { getLogger } from '../src/logger.js';
import type { PluginContext } from '../src/plugin-context.js';

it('logs a non-blocking experience packet write failure', async () => {
  const logged = mock.method(getLogger(), 'error', () => undefined);
  const failure = new Error('packet write failed');
  const ctx = {
    directory: 'project-root',
    toolDistiller: {
      distill: () => ({ id: 'summary-1', groups: [{}], compressed: 'summary',
        totalCallsSummarized: 1 }),
    },
    database: {
      getPool: () => ({ query: async () => ({ rows: [], rowCount: 1 }) }),
    },
    config: { distiller: { autoSaveAsMemory: false } },
    experiencePackets: {
      recordDistillGroupPacket: async () => { throw failure; },
    },
    refreshActiveContext: async () => undefined,
  } as unknown as PluginContext;

  await autoDistill(ctx, 'session-1');
  await new Promise<void>((resolve) => { setImmediate(resolve); });

  assert.equal(logged.mock.callCount(), 1);
  assert.equal(logged.mock.calls[0]?.arguments[0], 'Experience packet background write failed');
  assert.equal(logged.mock.calls[0]?.arguments[1], failure);
  logged.mock.restore();
});

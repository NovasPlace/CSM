import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createEventHook } from '../src/hooks/event-hooks.js';
import type { PluginContext } from '../src/plugin-context.js';

it('records only a checkpoint for session.updated', async () => {
  let checkpoints = 0;
  let sessionEnds = 0;
  let lifecycleMemories = 0;
  const pluginCtx = {
    config: { logSessionLifecycle: true },
    state: { currentSessionId: 'session-1', messageCount: 12 },
    experiencePackets: {
      recordSessionCheckpointPacket: async () => { checkpoints += 1; },
    },
    workJournal: {
      recordSessionEnd: async () => { sessionEnds += 1; },
    },
    memoryManager: {
      saveMemory: async () => { lifecycleMemories += 1; },
    },
  } as unknown as PluginContext;
  const hook = createEventHook({ directory: 'project-1' } as never, pluginCtx);

  await hook({ event: { type: 'session.updated', properties: {} } });

  assert.equal(checkpoints, 1);
  assert.equal(sessionEnds, 0);
  assert.equal(lifecycleMemories, 0);
});

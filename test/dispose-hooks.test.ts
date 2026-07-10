import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clearPendingUpdates } from '../dist/hooks/auto-docs.js';
import { disposeAll } from '../dist/hooks/dispose-hooks.js';

describe('disposeAll', () => {
  it('flushes stats before disconnecting the database', async () => {
    const order: string[] = [];
    clearPendingUpdates();
    await disposeAll({ directory: 'test-project' } as never, {
      config: {
        distiller: { enabled: false },
        logSessionLifecycle: false,
        workJournal: { persistOnDispose: false },
        selfContinuity: { enabled: false },
      },
      database: { disconnect: async () => { order.push('database.disconnect'); } },
      memoryManager: { cleanup: async () => { order.push('memory.cleanup'); } },
      toolDistiller: { distill: () => ({ groups: [] }) },
      redactor: {},
      contextRecall: { stop: () => { order.push('context.stop'); } },
      subconscious: { stop: () => { order.push('subconscious.stop'); } },
      gitWatcher: { stop: () => { order.push('git.stop'); } },
      workJournal: {},
      workLedger: { dispose: async () => { order.push('ledger.dispose'); } },
      statsWriter: { stopAndFlush: async () => { order.push('stats.flush'); } },
      state: { currentSessionId: null, messageCount: 0 },
      directory: 'test-project',
    } as never);
    clearPendingUpdates();
    assert.ok(order.indexOf('stats.flush') < order.indexOf('database.disconnect'));
    assert.ok(order.indexOf('ledger.dispose') < order.indexOf('database.disconnect'));
  });

  it('still disconnects when Work Ledger cleanup reports an error', async () => {
    const order: string[] = [];
    await assert.rejects(
      () => disposeAll({ directory: 'test-project' } as never, {
        config: { distiller: { enabled: false }, logSessionLifecycle: false,
          workJournal: { persistOnDispose: false }, selfContinuity: { enabled: false } },
        database: { disconnect: async () => { order.push('database.disconnect'); } },
        memoryManager: { cleanup: async () => {} }, toolDistiller: { distill: () => ({ groups: [] }) },
        redactor: {}, contextRecall: { stop() {} }, subconscious: { stop() {} }, gitWatcher: { stop() {} },
        workJournal: {}, workLedger: { dispose: async () => { throw new Error('lease cleanup'); } },
        statsWriter: { stopAndFlush: async () => {} }, state: { currentSessionId: null, messageCount: 0 },
        directory: 'test-project',
      } as never),
      /Runtime cleanup failed/,
    );
    assert.deepEqual(order, ['database.disconnect']);
  });
});

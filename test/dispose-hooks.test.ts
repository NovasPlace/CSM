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

  it('retries Work Ledger cleanup before disconnecting the database', async () => {
    const order: string[] = [];
    let ledgerAttempts = 0;
    const context = {
      config: { distiller: { enabled: false }, logSessionLifecycle: false,
        workJournal: { persistOnDispose: false }, selfContinuity: { enabled: false } },
      database: { disconnect: async () => { order.push('database.disconnect'); } },
      memoryManager: { cleanup: async () => {} }, toolDistiller: { distill: () => ({ groups: [] }) },
      redactor: {}, contextRecall: { stop() {} }, subconscious: { stop() {} }, gitWatcher: { stop() {} },
      workJournal: {}, workLedger: { dispose: async () => {
        ledgerAttempts += 1;
        if (ledgerAttempts === 1) throw new Error('lease cleanup');
      } },
      statsWriter: { stopAndFlush: async () => {} }, state: { currentSessionId: null, messageCount: 0 },
      directory: 'test-project',
    };
    await assert.rejects(
      () => disposeAll({ directory: 'test-project' } as never, context as never),
      /Runtime cleanup failed/,
    );
    assert.deepEqual(order, []);
    await disposeAll({ directory: 'test-project' } as never, context as never);
    assert.equal(ledgerAttempts, 2);
    assert.deepEqual(order, ['database.disconnect']);
  });

  it('runs non-database cleanup after an early persistence failure', async () => {
    const order: string[] = [];
    const context = failingContext(order);
    await assert.rejects(() => disposeAll({ directory: 'test-project' } as never, context as never),
      (error: unknown) => error instanceof AggregateError
        && error.errors.some((entry) => String(entry).includes('session snapshot')));
    assert.deepEqual(order, ['lifecycle.stop', 'context.stop', 'subconscious.stop', 'git.stop',
      'memory.cleanup', 'stats.flush', 'ledger.dispose']);
  });

  it('keeps the database open until failed persistence succeeds on retry', async () => {
    const order: string[] = [];
    const context = failingContext(order, false);
    let snapshotAttempts = 0;
    context.memoryManager.saveMemory = async () => {
      snapshotAttempts += 1;
      if (snapshotAttempts === 1) throw new Error('snapshot write failed');
    };
    await assert.rejects(() => disposeAll({ directory: 'test-project' } as never, context as never));
    assert.equal(order.includes('database.disconnect'), false);
    await disposeAll({ directory: 'test-project' } as never, context as never);
    assert.equal(snapshotAttempts, 2);
    assert.equal(order.filter((step) => step === 'database.disconnect').length, 1);
    assert.equal(order.filter((step) => step === 'memory.cleanup').length, 1);
  });

  it('coalesces concurrent disposal so cleanup runs exactly once', async () => {
    const order: string[] = [];
    const context = failingContext(order, false);
    await Promise.all([
      disposeAll({ directory: 'test-project' } as never, context as never),
      disposeAll({ directory: 'test-project' } as never, context as never),
      disposeAll({ directory: 'test-project' } as never, context as never),
    ]);
    assert.equal(order.filter((step) => step === 'database.disconnect').length, 1);
    assert.equal(order.filter((step) => step === 'memory.cleanup').length, 1);
  });

  it('retries only failed cleanup steps after a transient disposal error', async () => {
    const order: string[] = [];
    const context = failingContext(order, false) as ReturnType<typeof failingContext> & {
      database: { disconnect: () => Promise<void> };
    };
    let disconnects = 0;
    context.database.disconnect = async () => {
      disconnects += 1;
      order.push('database.disconnect');
      if (disconnects === 1) throw new Error('transient disconnect');
    };
    await assert.rejects(() => disposeAll({ directory: 'test-project' } as never, context as never));
    await disposeAll({ directory: 'test-project' } as never, context as never);
    assert.equal(disconnects, 2);
    assert.equal(order.filter((step) => step === 'memory.cleanup').length, 1);
    assert.equal(order.filter((step) => step === 'ledger.dispose').length, 1);
  });
});

function failingContext(order: string[], failSnapshot = true) {
  return {
    config: { distiller: { enabled: false }, logSessionLifecycle: true,
      workJournal: { persistOnDispose: false }, selfContinuity: { enabled: false } },
    database: { disconnect: async () => { order.push('database.disconnect'); } },
    memoryManager: { saveMemory: async () => {
      if (failSnapshot) throw new Error('snapshot write failed');
    }, cleanup: async () => { order.push('memory.cleanup'); } },
    toolDistiller: { distill: () => ({ groups: [] }) }, redactor: {},
    contextRecall: { stop: () => { order.push('context.stop'); } },
    subconscious: { stop: () => { order.push('subconscious.stop'); } },
    gitWatcher: { stop: () => { order.push('git.stop'); } }, workJournal: {},
    workLedger: { dispose: async () => { order.push('ledger.dispose'); } },
    statsWriter: { stopAndFlush: async () => { order.push('stats.flush'); } },
    lifecycleOrchestrator: { stop: () => { order.push('lifecycle.stop'); } },
    experiencePackets: { recordToolPacket: async () => {} },
    state: { currentSessionId: 'session-1', messageCount: 1 }, directory: 'test-project',
  };
}

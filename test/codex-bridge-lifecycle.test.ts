import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { CodexMemoryBridge } from '../dist/codex-bridge.js';
import { CodexBridgeLifecycle } from '../dist/codex-bridge-lifecycle.js';
import { createCodexBridgeRuntime } from '../dist/codex-bridge-runtime.js';
import { DEFAULT_CONFIG } from '../dist/config.js';
import type { Database } from '../dist/database.js';
import type { WorkLedger } from '../dist/work-ledger.js';

const BASE_URL = process.env.CSM_DATABASE_URL
  ?? 'postgresql://postgres:postgres@localhost:5432/cross_session_memory';
const DATABASE_NAME = `csm_bridge_lifecycle_${Date.now()}_${randomUUID().slice(0, 8)}`.replace(/-/g, '_');
const ROOT = resolve(`.tmp/bridge-lifecycle-${process.pid}`);
const FILE = resolve(ROOT, 'tracked.txt');
const admin = new Pool({ connectionString: databaseUrl('postgres') });

before(async () => {
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(FILE, 'before\n', 'utf8');
  await admin.query(`CREATE DATABASE ${quoteIdentifier(DATABASE_NAME)}`);
});

after(async () => {
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
    [DATABASE_NAME]);
  await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(DATABASE_NAME)}`);
  await admin.end();
  rmSync(ROOT, { recursive: true, force: true });
});

it('closes SQLite after a post-connect bridge startup failure', async () => {
  let database: Database | undefined;
  await assert.rejects(() => createCodexBridgeRuntime({
    ...DEFAULT_CONFIG, databaseProvider: 'sqlite', databaseUrl: ':memory:', sqlitePath: ':memory:',
  }, {
    afterDatabaseConnect: (connected) => {
      database = connected;
      throw new Error('injected bridge startup failure');
    },
  }), /injected bridge startup failure/);
  assert.equal((await database?.diagnose())?.startup.state, 'closed');
});

it('releases a pending PostgreSQL ledger lease when bridge construction fails', async () => {
  const order: string[] = [];
  let database: Database | undefined;
  await assert.rejects(() => createCodexBridgeRuntime(postgresConfig(), {
    beforeCommit: async (runtime) => {
      database = runtime.deps.database;
      instrumentRuntime(runtime.workLedger, runtime.deps.database, order);
      await runtime.workLedger?.captureBefore(capture('startup-run', 'startup-call'));
    },
    activate: () => { throw new Error('injected bridge construction failure'); },
  }), /injected bridge construction failure/);
  assert.deepEqual(order, ['workLedger', 'database']);
  assert.equal((await database?.diagnose())?.startup.state, 'closed');
  const retry = await createCodexBridgeRuntime(postgresConfig());
  await retry.workLedger?.captureBefore(capture('retry-run', 'retry-call'));
  await retry.workLedger?.dispose();
  await retry.deps.database.close();
});

it('keeps the database open when ledger disconnect fails and retries only unfinished work', async () => {
  const bridge = await CodexMemoryBridge.connect(postgresConfig());
  await bridge.beginWorkChange(capture('disconnect-run', 'disconnect-call'));
  const internal = bridge as unknown as { workLedger: WorkLedger; deps: { database: Database } };
  const dispose = internal.workLedger.dispose.bind(internal.workLedger);
  let attempts = 0;
  internal.workLedger.dispose = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('transient ledger shutdown');
    await dispose();
  };
  await assert.rejects(() => bridge.disconnect(), /Work Ledger disconnect failed/);
  assert.equal((await internal.deps.database.diagnose()).startup.state, 'ready');
  await bridge.disconnect();
  assert.equal(attempts, 2);
  assert.equal((await internal.deps.database.diagnose()).startup.state, 'closed');
});

it('coalesces concurrent disconnect and closes each resource once', async () => {
  const order: string[] = [];
  const lifecycle = new CodexBridgeLifecycle(
    { close: async () => { order.push('database'); } } as never,
    { dispose: async () => { order.push('workLedger'); } } as never,
  );
  await Promise.all([lifecycle.disconnect(), lifecycle.disconnect(), lifecycle.disconnect()]);
  await lifecycle.disconnect();
  assert.deepEqual(order, ['workLedger', 'database']);
});

it('drains an admitted operation and rejects new work while closing', async () => {
  const order: string[] = [];
  const gate = deferred<void>();
  const entered = deferred<void>();
  const lifecycle = new CodexBridgeLifecycle(
    { close: async () => { order.push('database'); } } as never,
    { dispose: async () => { order.push('workLedger'); } } as never,
  );
  const running = lifecycle.run(async () => {
    entered.resolve();
    await gate.promise;
  });
  await entered.promise;
  const closing = lifecycle.disconnect();
  await assert.rejects(() => lifecycle.run(async () => undefined), /bridge is closing/);
  assert.deepEqual(order, []);
  gate.resolve();
  await Promise.all([running, closing]);
  assert.deepEqual(order, ['workLedger', 'database']);
});

it('drains an admitted Work Ledger capture before disconnecting', async () => {
  const bridge = await CodexMemoryBridge.connect(postgresConfig());
  const internal = bridge as unknown as { workLedger: WorkLedger };
  const captureBefore = internal.workLedger.captureBefore.bind(internal.workLedger);
  const gate = deferred<void>();
  const entered = deferred<void>();
  internal.workLedger.captureBefore = async (input) => {
    entered.resolve();
    await gate.promise;
    await captureBefore(input);
  };
  const capturePromise = bridge.beginWorkChange(capture('drain-run', 'drain-call'));
  await entered.promise;
  const closing = bridge.disconnect();
  await assert.rejects(() => bridge.searchMemories({ query: 'blocked' }), /bridge is closing/);
  gate.resolve();
  await Promise.all([capturePromise, closing]);
  assert.deepEqual(bridge.listTools(), []);
  await assert.rejects(() => bridge.searchMemories({ query: 'closed' }), /bridge is closed/);
  assert.match(bridge.getDatabaseUrl(), new RegExp(DATABASE_NAME));
});

it('does not repeat completed ledger cleanup when database close needs retry', async () => {
  let ledgerCalls = 0;
  let databaseCalls = 0;
  const lifecycle = new CodexBridgeLifecycle(
    { close: async () => {
      databaseCalls += 1;
      if (databaseCalls === 1) throw new Error('transient database close');
    } } as never,
    { dispose: async () => { ledgerCalls += 1; } } as never,
  );
  await assert.rejects(() => lifecycle.disconnect(), /database disconnect failed/);
  await lifecycle.disconnect();
  assert.equal(ledgerCalls, 1);
  assert.equal(databaseCalls, 2);
});

function postgresConfig() {
  return { ...DEFAULT_CONFIG, databaseProvider: 'postgres' as const,
    databaseUrl: databaseUrl(DATABASE_NAME),
    workLedger: { ...DEFAULT_CONFIG.workLedger, enabled: true, captureTimeoutMs: 1_000 } };
}

function capture(runId: string, toolCallId: string) {
  return { runId, modelId: 'openai:gpt-5-codex', toolCallId, toolName: 'edit',
    projectRoot: ROOT, args: { filePath: 'tracked.txt' } };
}

function instrumentRuntime(ledger: WorkLedger | undefined, database: Database, order: string[]): void {
  if (ledger) {
    const dispose = ledger.dispose.bind(ledger);
    ledger.dispose = async () => { order.push('workLedger'); await dispose(); };
  }
  const close = database.close.bind(database);
  database.close = async () => { order.push('database'); await close(); };
}

function databaseUrl(name: string): string {
  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

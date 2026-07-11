import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { DEFAULT_CONFIG } from '../dist/config.js';
import { Database } from '../dist/database.js';
import { Logger } from '../dist/logger.js';
import type { PluginContext } from '../dist/plugin-context.js';
import { startPluginContext } from '../dist/plugin-runtime-start.js';
import { normalizeProviderRuntimeConfig } from '../dist/provider-runtime-config.js';
import { StartupRollback } from '../dist/startup-rollback.js';
import { WorkLedger } from '../dist/work-ledger.js';

const BASE_URL = process.env.CSM_DATABASE_URL
  ?? 'postgresql://postgres:postgres@localhost:5432/cross_session_memory';
const DATABASE_NAME = `csm_startup_rollback_${Date.now()}_${randomUUID().slice(0, 8)}`.replace(/-/g, '_');
const PROJECT_ROOT = resolve(`.tmp/startup-rollback-${process.pid}`);
const TRACKED_FILE = resolve(PROJECT_ROOT, 'tracked.txt');
const admin = new Pool({ connectionString: databaseUrl('postgres') });

before(async () => {
  mkdirSync(PROJECT_ROOT, { recursive: true });
  writeFileSync(TRACKED_FILE, 'before\n', 'utf8');
  await admin.query(`CREATE DATABASE ${quoteIdentifier(DATABASE_NAME)}`);
});

after(async () => {
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
    [DATABASE_NAME]);
  await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(DATABASE_NAME)}`);
  await admin.end();
  rmSync(PROJECT_ROOT, { recursive: true, force: true });
});

it('closes a real SQLite database when startup fails immediately after connection', async () => {
  let database: Database | undefined;
  await assert.rejects(() => startPluginContext(input(), sqliteConfig(), logger(), {
    afterDatabaseConnect: (connected) => {
      database = connected;
      throw new Error('injected post-connect failure');
    },
  }), /injected post-connect failure/);
  assert.equal((await database?.diagnose())?.startup.state, 'closed');
});

it('stops every started runtime and closes the database on late startup failure', async () => {
  const stopped: string[] = [];
  let runtime: PluginContext | undefined;
  await assert.rejects(() => startPluginContext(input(), sqliteConfig(), logger(), {
    beforeCommit: (pluginCtx) => {
      runtime = pluginCtx;
      wrapStop(pluginCtx, 'contextRecall', stopped);
      wrapStop(pluginCtx, 'subconscious', stopped);
      wrapStop(pluginCtx, 'gitWatcher', stopped);
      wrapStop(pluginCtx, 'lifecycleOrchestrator', stopped);
      const flush = pluginCtx.statsWriter.stopAndFlush.bind(pluginCtx.statsWriter);
      pluginCtx.statsWriter.stopAndFlush = async () => { stopped.push('statsWriter'); await flush(); };
      throw new Error('injected pre-commit failure');
    },
  }), /injected pre-commit failure/);
  assert.deepEqual(new Set(stopped), new Set([
    'contextRecall', 'subconscious', 'gitWatcher', 'lifecycleOrchestrator', 'statsWriter',
  ]));
  assert.equal((await runtime?.database.diagnose())?.startup.state, 'closed');
});

it('continues reverse-order rollback and reports cleanup failures with the startup cause', async () => {
  const order: string[] = [];
  const rollback = new StartupRollback();
  rollback.defer('first', () => { order.push('first'); });
  rollback.defer('second', () => { order.push('second'); throw new Error('cleanup failed'); });
  const startup = new Error('startup failed');
  await assert.rejects(() => rollback.fail(startup), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], startup);
    assert.match(String(error.errors[1]), /second: cleanup failed/);
    return true;
  });
  assert.deepEqual(order, ['second', 'first']);
});

it('rolls back hook assembly failure on PostgreSQL in exact dependency order', async () => {
  const order: string[] = [];
  let runtime: PluginContext | undefined;
  const previousStatsPath = process.env.OPENCODE_CSM_STATS_PATH;
  process.env.OPENCODE_CSM_STATS_PATH = resolve(PROJECT_ROOT, 'stats.json');
  try {
    await assert.rejects(() => startPluginContext(input(PROJECT_ROOT), postgresConfig(), logger(), {
      beforeCommit: async (pluginCtx) => {
        runtime = pluginCtx;
        instrumentCleanup(pluginCtx, order);
        await pluginCtx.workLedger?.captureBefore(capture('startup-run', 'startup-call'));
      },
      activate: () => { throw new Error('hook assembly failed'); },
    }), /hook assembly failed/);
  } finally {
    if (previousStatsPath === undefined) delete process.env.OPENCODE_CSM_STATS_PATH;
    else process.env.OPENCODE_CSM_STATS_PATH = previousStatsPath;
  }
  assert.deepEqual(order, [
    'lifecycleOrchestrator', 'gitWatcher', 'subconscious', 'contextRecall',
    'statsWriter', 'workLedger', 'database',
  ]);
  assert.equal((await runtime?.database.diagnose())?.startup.state, 'closed');
  await proveLedgerLeaseReleased();
});

function sqliteConfig() {
  return normalizeProviderRuntimeConfig({
    ...DEFAULT_CONFIG, databaseProvider: 'sqlite', databaseUrl: ':memory:', sqlitePath: ':memory:',
  });
}

function postgresConfig() {
  return { ...DEFAULT_CONFIG, databaseProvider: 'postgres' as const,
    databaseUrl: databaseUrl(DATABASE_NAME),
    workLedger: { ...DEFAULT_CONFIG.workLedger, enabled: true, captureTimeoutMs: 1_000 } };
}

function input(directory = 'startup-rollback-test') {
  return { directory, client: {} } as never;
}

function logger(): Logger {
  return new Logger({ projectId: 'startup-rollback-test', verbose: false });
}

function wrapStop(
  runtime: PluginContext,
  key: 'contextRecall' | 'subconscious' | 'gitWatcher' | 'lifecycleOrchestrator',
  stopped: string[],
): void {
  const service = runtime[key];
  if (!service) return;
  const stop = service.stop.bind(service);
  service.stop = () => { stopped.push(key); stop(); };
}

function instrumentCleanup(runtime: PluginContext, order: string[]): void {
  for (const key of ['contextRecall', 'subconscious', 'gitWatcher', 'lifecycleOrchestrator'] as const) {
    wrapStop(runtime, key, order);
  }
  const flush = runtime.statsWriter.stopAndFlush.bind(runtime.statsWriter);
  runtime.statsWriter.stopAndFlush = async () => { order.push('statsWriter'); await flush(); };
  const dispose = runtime.workLedger?.dispose.bind(runtime.workLedger);
  if (dispose && runtime.workLedger) {
    runtime.workLedger.dispose = async () => { order.push('workLedger'); await dispose(); };
  }
  const close = runtime.database.close.bind(runtime.database);
  runtime.database.close = async () => { order.push('database'); await close(); };
}

async function proveLedgerLeaseReleased(): Promise<void> {
  const database = new Database(postgresConfig());
  await database.connect();
  const ledger = new WorkLedger(database.getPool(), postgresConfig().workLedger);
  await ledger.captureBefore(capture('retry-run', 'retry-call'));
  await ledger.dispose();
  await database.close();
}

function capture(runId: string, toolCallId: string) {
  return { runId, modelId: 'openai:gpt-5-codex', toolCallId, toolName: 'edit',
    projectRoot: PROJECT_ROOT, args: { filePath: 'tracked.txt' } };
}

function databaseUrl(name: string): string {
  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

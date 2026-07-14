import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdirSync, rmSync } from 'node:fs';
import { Database } from '../src/database.js';
import { ContextInjectionLogger } from '../src/context-injection-logger.js';
import { ReEntryProtocol } from '../src/re-entry-protocol.js';
import { MemoryManager } from '../src/memory-manager.js';
import { SelfModelUpdater } from '../src/self-model-updater.js';
import { BeliefKnowledgeConsolidator } from '../src/belief-knowledge-store.js';
import { AgentWorkJournal } from '../src/agent-work-journal.js';
import { injectOnboardingContext } from '../src/hooks/onboarding-injection-guard.js';
import { injectReentryContext } from '../src/hooks/reentry-injection-guard.js';
import type { PluginContext } from '../src/plugin-context.js';
import type { PluginConfig } from '../src/types.js';

const directory = '.tmp/context-injection-runtime';
const path = `${directory}/runtime.sqlite`;
let database: Database;

function config(): PluginConfig {
  return {
    databaseUrl: path, databaseProvider: 'sqlite', sqlitePath: path,
    embeddingModel: 'nomic-embed-text', embeddingApiUrl: 'http://localhost:11434',
  } as PluginConfig;
}

function state() {
  return {
    currentSessionId: null, messageCount: 0, capturedMessageSizes: new Map(), recentUserMessages: new Map(),
    reentryInjected: new Set<string>(), onboardingInjected: new Set<string>(),
  };
}

function context(protocol?: ReEntryProtocol): PluginContext {
  const pool = database.getPool();
  return {
    config: config(), database, directory, state: state(),
    contextInjectionLogger: new ContextInjectionLogger(pool, { enabled: true, environment: 'fixture' }),
    reEntryProtocol: protocol,
  } as unknown as PluginContext;
}

async function reentryProtocol(): Promise<ReEntryProtocol> {
  const pool = database.getPool();
  await pool.query(`INSERT INTO memories (session_id, memory_type, content, importance, tags)
    VALUES ('runtime-reentry', 'episodic', 'finish the production wiring', 0.9, '[]')`);
  return new ReEntryProtocol({
    pool, memoryManager: new MemoryManager(pool), selfModel: new SelfModelUpdater(pool),
    beliefStore: new BeliefKnowledgeConsolidator(pool), workJournal: new AgentWorkJournal(pool),
    config: { enabled: true, previewOnly: false },
  });
}

beforeEach(async () => {
  mkdirSync(directory, { recursive: true });
  rmSync(path, { force: true });
  database = new Database(config());
  await database.connect();
});

afterEach(async () => { await database.disconnect(); });

describe('context injection runtime wiring', () => {
  it('onboarding guard injects and persists its telemetry record', async () => {
    const output = { system: [] as string[] };
    const ctx = context();
    assert.equal(await injectOnboardingContext(ctx, output, 'runtime-onboarding'), true);
    await ctx.contextInjectionLogger?.flush();
    const events = await database.getPool().query(
      `SELECT injection_kind, status FROM context_injection_events WHERE session_id = $1`, ['runtime-onboarding'],
    );
    assert.deepEqual(events.rows, [{ injection_kind: 'onboarding', status: 'injected' }]);
    assert.equal(output.system.length, 1);
  });

  it('re-entry guard injects and persists its telemetry record', async () => {
    const output = { system: [] as string[] };
    const ctx = context(await reentryProtocol());
    assert.equal(await injectReentryContext(ctx, output, 'runtime-reentry', 'full'), true);
    await ctx.contextInjectionLogger?.flush();
    const events = await database.getPool().query(
      `SELECT injection_kind, status FROM context_injection_events WHERE session_id = $1`, ['runtime-reentry'],
    );
    assert.deepEqual(events.rows, [{ injection_kind: 'reentry', status: 'injected' }]);
    assert.equal(output.system.length, 1);
  });
});

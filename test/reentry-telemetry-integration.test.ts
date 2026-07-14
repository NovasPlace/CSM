import assert from 'node:assert/strict';
import { it, describe, before, beforeEach, afterEach } from 'node:test';
import { mkdirSync, rmSync } from 'node:fs';
import { Database } from '../src/database.js';
import { ReEntryProtocol } from '../src/re-entry-protocol.js';
import { ContextInjectionLogger } from '../src/context-injection-logger.js';
import { MemoryManager } from '../src/memory-manager.js';
import { SelfModelUpdater } from '../src/self-model-updater.js';
import { BeliefKnowledgeConsolidator } from '../src/belief-knowledge-store.js';
import { AgentWorkJournal } from '../src/agent-work-journal.js';
import type { DatabasePool, PluginConfig } from '../src/types.js';

const SQLITE_DIR = '.tmp/sqlite-integration';
const SQLITE_PATH = `${SQLITE_DIR}/integration-test.sqlite`;

function createSqliteConfig(): PluginConfig {
  return {
    databaseUrl: SQLITE_PATH,
    databaseProvider: 'sqlite',
    sqlitePath: SQLITE_PATH,
    embeddingModel: 'nomic-embed-text',
    embeddingApiUrl: 'http://localhost:11434',
  } as PluginConfig;
}

async function seedMemories(pool: DatabasePool): Promise<void> {
  await pool.query(
    `INSERT INTO memories (session_id, memory_type, content, importance, tags)
     VALUES ('s1', 'episodic', 'Complete the API refactor', 0.9, '["goal"]')`,
  );
  await pool.query(
    `INSERT INTO memories (session_id, memory_type, content, importance, tags)
     VALUES ('s1', 'preference', 'Use TypeScript strict mode', 0.8, '["preference"]')`,
  );
  await pool.query(
    `INSERT INTO memories (session_id, memory_type, content, importance, tags)
     VALUES ('s1', 'lesson', 'Never commit directly to main', 0.95, '["constraint"]')`,
  );
}

describe('Re-entry integration — live injection produces telemetry', () => {
  let db: Database;
  let pool: DatabasePool;
  let protocol: ReEntryProtocol;
  let logger: ContextInjectionLogger;

  before(() => {
    try { mkdirSync(SQLITE_DIR, { recursive: true }); } catch { /* exists */ }
  });

  beforeEach(async () => {
    try { await db?.disconnect(); } catch { /* not connected */ }
    try { rmSync(SQLITE_PATH); } catch { /* not exists */ }
    try { rmSync(`${SQLITE_PATH}-wal`); } catch { /* not exists */ }
    try { rmSync(`${SQLITE_PATH}-shm`); } catch { /* not exists */ }
    db = new Database(createSqliteConfig());
    await db.connect();
    pool = db.getPool();
    await seedMemories(pool);

    protocol = new ReEntryProtocol({
      pool, memoryManager: new MemoryManager(pool),
      selfModel: new SelfModelUpdater(pool),
      beliefStore: new BeliefKnowledgeConsolidator(pool),
      workJournal: new AgentWorkJournal(pool),
      config: { enabled: true, previewOnly: false },
    });
    logger = new ContextInjectionLogger(pool, { enabled: true, environment: 'fixture' });
  });

  afterEach(async () => {
    try { await db?.disconnect(); } catch { /* closed */ }
  });

  it('real injection produces telemetry event + item rows', async () => {
    const built = await protocol.buildBlockWithProvenance('s1', 'test-project');
    assert.ok(built !== null, 'buildBlockWithProvenance must return data');

    await logger.logInjection({
      idempotencyKey: 'reentry:s1',
      projectId: 'test-project',
      sessionId: 's1',
      injectionKind: 'reentry',
      sourceTurnId: null,
      built,
      blockHash: null,
      status: 'injected',
    });
    await logger.flush();

    const events = await pool.query('SELECT * FROM context_injection_events');
    assert.equal(events.rows.length, 1);
    const event = events.rows[0] as Record<string, unknown>;
    assert.equal(event.injection_kind, 'reentry');
    assert.equal(event.status, 'injected');

    const items = await pool.query('SELECT * FROM context_injection_items');
    assert.ok(items.rows.length > 0, 'must write item rows');
    assert.equal(items.rows.length, built.items.length);
  });

  it('skipped injection logs status=skipped', async () => {
    const built = await protocol.buildBlockWithProvenance('s1', 'test-project');
    assert.ok(built !== null);

    await logger.logInjection({
      idempotencyKey: 'reentry:s1',
      projectId: 'test-project',
      sessionId: 's1',
      injectionKind: 'reentry',
      sourceTurnId: null,
      built,
      blockHash: null,
      status: 'skipped',
    });
    await logger.flush();

    const events = await pool.query('SELECT * FROM context_injection_events');
    assert.equal(events.rows.length, 1);
    const event = events.rows[0] as Record<string, unknown>;
    assert.equal(event.status, 'skipped');
  });

  it('logger failure does not escape into caller', async () => {
    const built = await protocol.buildBlockWithProvenance('s1', 'test-project');
    assert.ok(built !== null);

    const brokenLogger = new ContextInjectionLogger(pool, { enabled: true, environment: 'fixture' });
    (brokenLogger as unknown as { writeRecord: () => never }).writeRecord = () => {
      throw new Error('simulated logger failure');
    };

    await assert.doesNotReject(
      brokenLogger.logInjection({
        idempotencyKey: 'reentry:s1-broken',
        projectId: 'test-project',
        sessionId: 's1',
        injectionKind: 'reentry',
        sourceTurnId: null,
        built,
        blockHash: null,
        status: 'injected',
      }),
    );
    await brokenLogger.flush();
  });

  it('no duplicate writes: same idempotency_key = one event', async () => {
    const built = await protocol.buildBlockWithProvenance('s1', 'test-project');
    assert.ok(built !== null);

    const record = {
      idempotencyKey: 'reentry:s1',
      projectId: 'test-project',
      sessionId: 's1',
      injectionKind: 'reentry',
      sourceTurnId: null,
      built,
      blockHash: null,
      status: 'injected' as const,
    };

    await logger.logInjection(record);
    await logger.flush();
    await logger.logInjection(record);
    await logger.flush();

    const events = await pool.query('SELECT * FROM context_injection_events');
    assert.equal(events.rows.length, 1, 'duplicate key must produce one event');
  });

  it('disabled protocol produces no telemetry', async () => {
    const disabledProtocol = new ReEntryProtocol({
      pool, memoryManager: new MemoryManager(pool),
      selfModel: new SelfModelUpdater(pool),
      beliefStore: new BeliefKnowledgeConsolidator(pool),
      workJournal: new AgentWorkJournal(pool),
      config: { enabled: false },
    });
    const built = await disabledProtocol.buildBlockWithProvenance('s1', 'test-project');
    assert.equal(built, null, 'disabled protocol returns null');
  });

  it('provenance items match BuiltContextInjection', async () => {
    const built = await protocol.buildBlockWithProvenance('s1', 'test-project');
    assert.ok(built !== null);

    await logger.logInjection({
      idempotencyKey: 'reentry:s1-prov',
      projectId: 'test-project',
      sessionId: 's1',
      injectionKind: 'reentry',
      sourceTurnId: null,
      built,
      blockHash: null,
      status: 'injected',
    });
    await logger.flush();

    const items = await pool.query('SELECT * FROM context_injection_items');
    const dbMap = new Map(
      items.rows.map((r: Record<string, unknown>) => [`${r.layer_name}:${r.position}`, r]),
    );
    for (const builtItem of built.items) {
      const key = `${builtItem.layerName}:${builtItem.position}`;
      const dbItem = dbMap.get(key) as Record<string, unknown> | undefined;
      assert.ok(dbItem, `DB item missing for ${key}`);
      assert.equal(dbItem.layer_name, builtItem.layerName);
      assert.equal(dbItem.source_kind, builtItem.sourceKind);
      assert.equal(dbItem.disposition, builtItem.disposition);
      assert.equal(dbItem.provenance_granularity, builtItem.provenanceGranularity);
    }
  });

});

import assert from 'node:assert/strict';
import { it, describe, before, beforeEach, afterEach } from 'node:test';
import { mkdirSync, rmSync } from 'node:fs';
import { Database } from '../src/database.js';
import { ContextInjectionLogger, type InjectionLogRecord } from '../src/context-injection-logger.js';
import type { BuiltContextInjection } from '../src/context-injection-contract.js';
import type { DatabasePool, PluginConfig } from '../src/types.js';

const SQLITE_DIR = '.tmp/sqlite-logger';
const SQLITE_PATH = `${SQLITE_DIR}/logger-test.sqlite`;

function createSqliteConfig(): PluginConfig {
  return {
    databaseUrl: SQLITE_PATH,
    databaseProvider: 'sqlite',
    sqlitePath: SQLITE_PATH,
    embeddingModel: 'nomic-embed-text',
    embeddingApiUrl: 'http://localhost:11434',
  } as PluginConfig;
}

function createBuilt(): BuiltContextInjection {
  return {
    text: '## Identity\nProject: test\n## Goals\n- goal1\n- goal2',
    injectionKind: 'reentry',
    items: [
      { layerName: 'identity', sourceKind: 'derived_state', sourceId: 'session', memoryId: null,
        position: 0, selectionRank: null, selectionScore: null, selectionReason: null,
        disposition: 'injected', provenanceGranularity: 'layer', charCount: 30, metadata: {} },
      { layerName: 'goals', sourceKind: 'memory', sourceId: 'memory:1', memoryId: null,
        position: 0, selectionRank: 0, selectionScore: 0.9, selectionReason: 'importance_rank',
        disposition: 'injected', provenanceGranularity: 'item', charCount: 8, metadata: {} },
      { layerName: 'goals', sourceKind: 'memory', sourceId: 'memory:2', memoryId: null,
        position: 1, selectionRank: 1, selectionScore: 0.8, selectionReason: 'importance_rank',
        disposition: 'injected', provenanceGranularity: 'item', charCount: 8, metadata: {} },
    ],
    layers: [
      { layerName: 'identity', status: 'included', originalChars: 30, finalChars: 30, itemCount: 1, trimReason: null },
      { layerName: 'goals', status: 'included', originalChars: 16, finalChars: 16, itemCount: 2, trimReason: null },
    ],
    charCount: 46,
    estimatedTokens: 12,
    trimLevel: 'none',
    builderVersion: 'test-v1',
    configHash: 'cfg_test0000',
    metadata: { sessionId: 's1', projectId: 'p1' },
  };
}

function createRecord(overrides: Partial<InjectionLogRecord> = {}): InjectionLogRecord {
  return {
    idempotencyKey: 'test-key-001',
    projectId: 'test-project',
    sessionId: 's1',
    injectionKind: 'reentry',
    sourceTurnId: null,
    built: createBuilt(),
    blockHash: 'hash123',
    ...overrides,
  };
}

describe('Context injection logger - SQLite', () => {
  let db: Database;
  let pool: DatabasePool;
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
    logger = new ContextInjectionLogger(pool, { enabled: true, environment: 'fixture' });
  });

  afterEach(async () => {
    try { await db?.disconnect(); } catch { /* closed */ }
  });

  it('happy path: writes event row', async () => {
    await logger.logInjection(createRecord());
    await logger.flush();
    const events = await pool.query('SELECT * FROM context_injection_events');
    assert.equal(events.rows.length, 1);
    const event = events.rows[0] as Record<string, unknown>;
    assert.equal(event.idempotency_key, 'test-key-001');
    assert.equal(event.session_id, 's1');
    assert.equal(event.injection_kind, 'reentry');
    assert.equal(event.environment, 'fixture');
    assert.equal(event.status, 'injected');
    assert.equal(event.char_count, 46);
    assert.equal(event.estimated_tokens, 12);
    assert.equal(event.block_hash, 'hash123');
    assert.equal(event.builder_version, 'test-v1');
    assert.equal(event.config_hash, 'cfg_test0000');
  });

  it('happy path: writes item rows', async () => {
    await logger.logInjection(createRecord());
    await logger.flush();
    const items = await pool.query('SELECT * FROM context_injection_items ORDER BY layer_name, position');
    assert.equal(items.rows.length, 3);
    const identity = items.rows.find((row: Record<string, unknown>) => row.layer_name === 'identity') as Record<string, unknown>;
    assert.equal(identity.layer_name, 'identity');
    assert.equal(identity.source_kind, 'derived_state');
    assert.equal(identity.memory_id, null);
    assert.equal(identity.disposition, 'injected');
    assert.equal(identity.provenance_granularity, 'layer');
    const goal0 = items.rows.find((row: Record<string, unknown>) => row.layer_name === 'goals' && row.position === 0) as Record<string, unknown>;
    assert.equal(goal0.layer_name, 'goals');
    assert.equal(goal0.source_kind, 'memory');
    assert.equal(goal0.memory_id, null);
    assert.equal(goal0.position, 0);
    assert.equal(goal0.selection_rank, 0);
    assert.equal(goal0.selection_score, 0.9);
    assert.equal(goal0.selection_reason_code, 'importance_rank');
  });

  it('happy path: preserves provenance metadata', async () => {
    await logger.logInjection(createRecord({
      built: {
        ...createBuilt(),
        items: [
          { layerName: 'goals', sourceKind: 'memory', sourceId: 'memory:1', memoryId: null,
            position: 0, selectionRank: 0, selectionScore: 0.9, selectionReason: 'importance_rank',
            disposition: 'injected', provenanceGranularity: 'item', charCount: 8,
            metadata: { tags: ['goal', 'decision'], custom: 'value' } },
        ],
      },
    }));
    await logger.flush();
    const items = await pool.query('SELECT metadata FROM context_injection_items');
    const meta = JSON.parse((items.rows[0] as Record<string, unknown>).metadata as string);
    assert.deepEqual(meta, { tags: ['goal', 'decision'], custom: 'value' });
  });

  it('fail-open: broken DB does not throw', async () => {
    const brokenPool = {
      getDialect: () => 'sqlite',
      connect: () => Promise.reject(new Error('connection refused')),
      query: () => Promise.reject(new Error('should not be called')),
      close: () => Promise.resolve(),
    } as unknown as DatabasePool;
    const brokenLogger = new ContextInjectionLogger(brokenPool, { enabled: true, environment: 'fixture' });
    await assert.doesNotReject(brokenLogger.logInjection(createRecord()));
    await brokenLogger.flush();
  });

  it('fail-open: logger failure does not affect caller', async () => {
    const record = createRecord();
    await assert.doesNotReject(logger.logInjection(record));
    await logger.flush();
    const events = await pool.query('SELECT * FROM context_injection_events');
    assert.equal(events.rows.length, 1);
  });

  it('idempotency: same record twice = one persisted event', async () => {
    const record = createRecord();
    await logger.logInjection(record);
    await logger.flush();
    await logger.logInjection(record);
    await logger.flush();
    const events = await pool.query('SELECT * FROM context_injection_events');
    assert.equal(events.rows.length, 1);
  });

  it('idempotency: duplicate items are not re-inserted', async () => {
    const record = createRecord();
    await logger.logInjection(record);
    await logger.flush();
    await logger.logInjection(record);
    await logger.flush();
    const items = await pool.query('SELECT * FROM context_injection_items');
    assert.equal(items.rows.length, 3);
  });

  it('concurrent instances cannot delete a successful idempotent event', async () => {
    const valid = new ContextInjectionLogger(pool, { enabled: true, environment: 'fixture' });
    const invalid = new ContextInjectionLogger(pool, { enabled: true, environment: 'fixture' });
    const invalidRecord = createRecord({
      built: { ...createBuilt(), items: [{
        layerName: 'goals', sourceKind: 'memory', sourceId: 'memory:missing', memoryId: 999999,
        position: 0, selectionRank: 0, selectionScore: null, selectionReason: null,
        disposition: 'injected', provenanceGranularity: 'item', charCount: 1, metadata: {},
      }] },
    });
    await Promise.all([valid.logInjection(createRecord()), invalid.logInjection(invalidRecord)]);
    await Promise.all([valid.flush(), invalid.flush()]);
    const events = await pool.query('SELECT * FROM context_injection_events');
    assert.equal(events.rows.length, 1);
  });

  it('atomicity: partial failure rolls back event', async () => {
    // Create a record with an item that has a non-existent memory_id
    // This will fail the FK constraint and trigger rollback
    const record = createRecord({
      built: {
        ...createBuilt(),
        items: [
          { layerName: 'goals', sourceKind: 'memory' as const, sourceId: 'memory:1', memoryId: 999999,
            position: 0, selectionRank: 0, selectionScore: 0.9, selectionReason: 'importance_rank',
            disposition: 'injected', provenanceGranularity: 'item', charCount: 8, metadata: {} },
        ],
      },
    });
    await logger.logInjection(record);
    await logger.flush();
    const events = await pool.query('SELECT * FROM context_injection_events');
    assert.equal(events.rows.length, 0, 'event must not persist if items failed');
    const items = await pool.query('SELECT * FROM context_injection_items');
    assert.equal(items.rows.length, 0);
  });

  it('disabled logger: no writes', async () => {
    const disabledLogger = new ContextInjectionLogger(pool, { enabled: false, environment: 'fixture' });
    await disabledLogger.logInjection(createRecord());
    await disabledLogger.flush();
    const events = await pool.query('SELECT * FROM context_injection_events');
    assert.equal(events.rows.length, 0);
  });

  it('no content stored: rendered text is not in event or items', async () => {
    await logger.logInjection(createRecord());
    await logger.flush();
    const eventCols = await pool.query(`PRAGMA table_info(context_injection_events)`);
    const eventNames = eventCols.rows.map((r: Record<string, unknown>) => r.name);
    assert.ok(!eventNames.includes('text'));
    assert.ok(!eventNames.includes('rendered_text'));
    assert.ok(!eventNames.includes('content'));
    assert.ok(!eventNames.includes('block_text'));
    const itemCols = await pool.query(`PRAGMA table_info(context_injection_items)`);
    const itemNames = itemCols.rows.map((r: Record<string, unknown>) => r.name);
    assert.ok(!itemNames.includes('text'));
    assert.ok(!itemNames.includes('content'));
  });

  it('multiple injections: different idempotency keys create separate events', async () => {
    await logger.logInjection(createRecord({ idempotencyKey: 'key-a' }));
    await logger.logInjection(createRecord({ idempotencyKey: 'key-b' }));
    await logger.flush();
    const events = await pool.query('SELECT * FROM context_injection_events ORDER BY idempotency_key');
    assert.equal(events.rows.length, 2);
    assert.equal((events.rows[0] as Record<string, unknown>).idempotency_key, 'key-a');
    assert.equal((events.rows[1] as Record<string, unknown>).idempotency_key, 'key-b');
  });

  it('flush waits for pending writes', async () => {
    logger.logInjection(createRecord({ idempotencyKey: 'flush-1' }));
    logger.logInjection(createRecord({ idempotencyKey: 'flush-2' }));
    await logger.flush();
    const events = await pool.query('SELECT * FROM context_injection_events ORDER BY idempotency_key');
    assert.equal(events.rows.length, 2);
  });

  it('different injection kinds: onboarding is recorded', async () => {
    await logger.logInjection(createRecord({
      idempotencyKey: 'onboard-1',
      injectionKind: 'onboarding',
    }));
    await logger.flush();
    const events = await pool.query(`SELECT * FROM context_injection_events WHERE injection_kind = 'onboarding'`);
    assert.equal(events.rows.length, 1);
  });
});

describe('Context injection logger - PostgreSQL', () => {
  const PG_URL = process.env.CSM_DATABASE_URL ?? '';
  let pool: DatabasePool;
  let logger: ContextInjectionLogger;

  beforeEach(async () => {
    if (!PG_URL) return;
    const { DEFAULT_CONFIG } = await import('../src/config.js');
    const db = new Database(DEFAULT_CONFIG);
    await db.connect();
    pool = db.getPool();
    await pool.query(`DELETE FROM context_injection_items WHERE injection_event_id IN (SELECT id FROM context_injection_events WHERE idempotency_key LIKE 'test-log-%')`);
    await pool.query(`DELETE FROM context_injection_events WHERE idempotency_key LIKE 'test-log-%'`);
    logger = new ContextInjectionLogger(pool, { enabled: true, environment: 'fixture' });
  });

  afterEach(async () => {
    if (!PG_URL) return;
    await pool.query(`DELETE FROM context_injection_items WHERE injection_event_id IN (SELECT id FROM context_injection_events WHERE idempotency_key LIKE 'test-log-%')`);
    await pool.query(`DELETE FROM context_injection_events WHERE idempotency_key LIKE 'test-log-%'`);
    try { await pool.close(); } catch { /* closed */ }
  });

  it('happy path: writes event and item rows', { skip: !PG_URL }, async () => {
    await logger.logInjection(createRecord({ idempotencyKey: 'test-log-001' }));
    await logger.flush();
    const events = await pool.query(`SELECT * FROM context_injection_events WHERE idempotency_key = 'test-log-001'`);
    assert.equal(events.rows.length, 1);
    const items = await pool.query(`SELECT * FROM context_injection_items WHERE injection_event_id = $1`, [events.rows[0].id]);
    assert.equal(items.rows.length, 3);
  });

  it('idempotency: same record twice = one event', { skip: !PG_URL }, async () => {
    const record = createRecord({ idempotencyKey: 'test-log-002' });
    await logger.logInjection(record);
    await logger.flush();
    await logger.logInjection(record);
    await logger.flush();
    const events = await pool.query(`SELECT * FROM context_injection_events WHERE idempotency_key = 'test-log-002'`);
    assert.equal(events.rows.length, 1);
  });

  it('fail-open: broken DB does not throw', { skip: !PG_URL }, async () => {
    const brokenPool = {
      getDialect: () => 'pg',
      connect: () => Promise.reject(new Error('connection refused')),
      query: () => Promise.reject(new Error('should not be called')),
      close: () => Promise.resolve(),
    } as unknown as DatabasePool;
    const brokenLogger = new ContextInjectionLogger(brokenPool, { enabled: true, environment: 'fixture' });
    await assert.doesNotReject(brokenLogger.logInjection(createRecord()));
    await brokenLogger.flush();
  });

  it('no content stored: text column does not exist', { skip: !PG_URL }, async () => {
    const cols = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'context_injection_events'
      AND column_name IN ('text', 'rendered_text', 'content', 'block_text')
    `);
    assert.equal(cols.rows.length, 0);
  });
});

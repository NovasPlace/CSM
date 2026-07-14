import assert from 'node:assert/strict';
import { it, describe, before, beforeEach, afterEach } from 'node:test';
import { mkdirSync, rmSync } from 'node:fs';
import { Database } from '../src/database.js';
import { ContextInjectionLogger } from '../src/context-injection-logger.js';
import { buildInjectionAuditReport, formatAuditReport } from '../src/context-injection-audit.js';
import type { BuiltContextInjection } from '../src/context-injection-contract.js';
import type { DatabasePool, PluginConfig } from '../src/types.js';

const SQLITE_DIR = '.tmp/sqlite-audit';
const SQLITE_PATH = `${SQLITE_DIR}/audit-test.sqlite`;

function createSqliteConfig(): PluginConfig {
  return {
    databaseUrl: SQLITE_PATH,
    databaseProvider: 'sqlite',
    sqlitePath: SQLITE_PATH,
    embeddingModel: 'nomic-embed-text',
    embeddingApiUrl: 'http://localhost:11434',
  } as PluginConfig;
}

function createBuilt(
  overrides: { items?: BuiltContextInjection['items']; kind?: string; trimLevel?: string } = {},
): BuiltContextInjection {
  return {
    text: '## Identity\nProject: test',
    injectionKind: (overrides.kind ?? 'reentry') as 'reentry',
    items: overrides.items ?? [
      { layerName: 'identity', sourceKind: 'derived_state', sourceId: 'session', memoryId: null,
        position: 0, selectionRank: null, selectionScore: null, selectionReason: null,
        disposition: 'injected', provenanceGranularity: 'layer', charCount: 30, metadata: {} },
    ],
    layers: [],
    charCount: 30,
    estimatedTokens: 8,
    trimLevel: (overrides.trimLevel ?? 'none') as 'none',
    builderVersion: 'test-v1',
    configHash: 'cfg_test0000',
    metadata: {},
  };
}

describe('Context injection audit — SQLite', () => {
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

  it('empty database produces empty report', async () => {
    const report = await buildInjectionAuditReport(pool);
    assert.equal(report.summary.totalEvents, 0);
    assert.equal(report.provenance.totalItems, 0);
    assert.equal(report.layerPressure.byLayer.length, 0);
    assert.equal(report.recallRelationship.recalledMemories, 0);
    assert.equal(report.recallRelationship.injectionRate, null);
  });

  it('mixed events produce correct counts', async () => {
    // Inject two re-entry events and one onboarding event
    await logger.logInjection({
      idempotencyKey: 'reentry-1', projectId: 'p1', sessionId: 's1',
      injectionKind: 'reentry', sourceTurnId: null,
      built: createBuilt(), blockHash: null, status: 'injected',
    });
    await logger.logInjection({
      idempotencyKey: 'reentry-2', projectId: 'p1', sessionId: 's2',
      injectionKind: 'reentry', sourceTurnId: null,
      built: createBuilt({ trimLevel: 'soft' }), blockHash: null, status: 'injected',
    });
    await logger.logInjection({
      idempotencyKey: 'onboard-1', projectId: 'p1', sessionId: 's3',
      injectionKind: 'onboarding', sourceTurnId: null,
      built: createBuilt({ kind: 'onboarding' }), blockHash: null, status: 'injected',
    });
    await logger.logInjection({
      idempotencyKey: 'skip-1', projectId: 'p1', sessionId: 's4',
      injectionKind: 'reentry', sourceTurnId: null,
      built: createBuilt(), blockHash: null, status: 'skipped',
    });
    await logger.flush();

    const report = await buildInjectionAuditReport(pool);
    assert.equal(report.summary.totalEvents, 4);
    assert.equal(report.summary.byKind.reentry, 3);
    assert.equal(report.summary.byKind.onboarding, 1);
    assert.equal(report.summary.byStatus.injected, 3);
    assert.equal(report.summary.byStatus.skipped, 1);
  });

  it('provenance: source kind breakdown is correct', async () => {
    await logger.logInjection({
      idempotencyKey: 'prov-1', projectId: 'p1', sessionId: 's1',
      injectionKind: 'reentry', sourceTurnId: null,
      built: createBuilt({
        items: [
          { layerName: 'goals', sourceKind: 'memory', sourceId: 'memory:1', memoryId: null,
            position: 0, selectionRank: 0, selectionScore: 0.9, selectionReason: 'importance_rank',
            disposition: 'injected', provenanceGranularity: 'item', charCount: 8, metadata: {} },
          { layerName: 'identity', sourceKind: 'derived_state', sourceId: 'session', memoryId: null,
            position: 0, selectionRank: null, selectionScore: null, selectionReason: null,
            disposition: 'injected', provenanceGranularity: 'layer', charCount: 30, metadata: {} },
          { layerName: 'goals', sourceKind: 'memory', sourceId: 'memory:2', memoryId: null,
            position: 1, selectionRank: 1, selectionScore: 0.8, selectionReason: 'importance_rank',
            disposition: 'trimmed', provenanceGranularity: 'item', charCount: 0, metadata: {} },
        ],
      }),
      blockHash: null, status: 'injected',
    });
    await logger.flush();

    const report = await buildInjectionAuditReport(pool);
    assert.equal(report.provenance.totalItems, 3);
    assert.equal(report.provenance.bySourceKind.memory, 2);
    assert.equal(report.provenance.bySourceKind.derived_state, 1);
    assert.equal(report.provenance.byDisposition.injected, 2);
    assert.equal(report.provenance.byDisposition.trimmed, 1);
    assert.equal(report.provenance.byProvenanceGranularity.item, 2);
    assert.equal(report.provenance.byProvenanceGranularity.layer, 1);
  });

  it('trimmed/omitted items produce correct percentages', async () => {
    await logger.logInjection({
      idempotencyKey: 'trim-1', projectId: 'p1', sessionId: 's1',
      injectionKind: 'reentry', sourceTurnId: null,
      built: createBuilt({
        items: [
          { layerName: 'goals', sourceKind: 'memory', sourceId: 'm:1', memoryId: null,
            position: 0, selectionRank: 0, selectionScore: 0.9, selectionReason: 'importance_rank',
            disposition: 'injected', provenanceGranularity: 'item', charCount: 100, metadata: {} },
          { layerName: 'goals', sourceKind: 'memory', sourceId: 'm:2', memoryId: null,
            position: 1, selectionRank: 1, selectionScore: 0.5, selectionReason: 'budget_trim',
            disposition: 'trimmed', provenanceGranularity: 'item', charCount: 0, metadata: {} },
          { layerName: 'recent', sourceKind: 'memory', sourceId: 'm:3', memoryId: null,
            position: 0, selectionRank: null, selectionScore: null, selectionReason: 'layer_budget_exhausted',
            disposition: 'omitted', provenanceGranularity: 'layer', charCount: 0, metadata: {} },
        ],
      }),
      blockHash: null, status: 'injected',
    });
    await logger.flush();

    const report = await buildInjectionAuditReport(pool);
    assert.equal(report.provenance.byDisposition.injected, 1);
    assert.equal(report.provenance.byDisposition.trimmed, 1);
    assert.equal(report.provenance.byDisposition.omitted, 1);
  });

  it('re-entry + onboarding aggregation produces correct split', async () => {
    await logger.logInjection({
      idempotencyKey: 'split-r1', projectId: 'p1', sessionId: 's1',
      injectionKind: 'reentry', sourceTurnId: null,
      built: createBuilt(), blockHash: null, status: 'injected',
    });
    await logger.logInjection({
      idempotencyKey: 'split-r2', projectId: 'p1', sessionId: 's2',
      injectionKind: 'reentry', sourceTurnId: null,
      built: createBuilt(), blockHash: null, status: 'injected',
    });
    await logger.logInjection({
      idempotencyKey: 'split-o1', projectId: 'p1', sessionId: 's3',
      injectionKind: 'onboarding', sourceTurnId: null,
      built: createBuilt({ kind: 'onboarding' }), blockHash: null, status: 'injected',
    });
    await logger.flush();

    const report = await buildInjectionAuditReport(pool);
    assert.equal(report.summary.byKind.reentry, 2);
    assert.equal(report.summary.byKind.onboarding, 1);
    assert.equal(report.summary.totalEvents, 3);
  });

  it('read-only: no mutations to event/item tables', async () => {
    await logger.logInjection({
      idempotencyKey: 'ro-1', projectId: 'p1', sessionId: 's1',
      injectionKind: 'reentry', sourceTurnId: null,
      built: createBuilt(), blockHash: null, status: 'injected',
    });
    await logger.flush();

    const beforeEvents = await pool.query('SELECT COUNT(*) as cnt FROM context_injection_events');
    const beforeItems = await pool.query('SELECT COUNT(*) as cnt FROM context_injection_items');

    await buildInjectionAuditReport(pool);

    const afterEvents = await pool.query('SELECT COUNT(*) as cnt FROM context_injection_events');
    const afterItems = await pool.query('SELECT COUNT(*) as cnt FROM context_injection_items');

    assert.equal(Number(afterEvents.rows[0].cnt), Number(beforeEvents.rows[0].cnt));
    assert.equal(Number(afterItems.rows[0].cnt), Number(beforeItems.rows[0].cnt));
  });

  it('layer pressure: correct per-layer breakdown', async () => {
    await logger.logInjection({
      idempotencyKey: 'layer-1', projectId: 'p1', sessionId: 's1',
      injectionKind: 'reentry', sourceTurnId: null,
      built: createBuilt({
        items: [
          { layerName: 'goals', sourceKind: 'memory', sourceId: 'm:1', memoryId: null,
            position: 0, selectionRank: 0, selectionScore: 0.9, selectionReason: 'importance_rank',
            disposition: 'injected', provenanceGranularity: 'item', charCount: 100, metadata: {} },
          { layerName: 'goals', sourceKind: 'memory', sourceId: 'm:2', memoryId: null,
            position: 1, selectionRank: 1, selectionScore: 0.5, selectionReason: 'budget_trim',
            disposition: 'trimmed', provenanceGranularity: 'item', charCount: 0, metadata: {} },
          { layerName: 'identity', sourceKind: 'derived_state', sourceId: 'session', memoryId: null,
            position: 0, selectionRank: null, selectionScore: null, selectionReason: null,
            disposition: 'injected', provenanceGranularity: 'layer', charCount: 200, metadata: {} },
        ],
      }),
      blockHash: null, status: 'injected',
    });
    await logger.flush();

    const report = await buildInjectionAuditReport(pool);
    assert.equal(report.layerPressure.byLayer.length, 2);
    const goals = report.layerPressure.byLayer.find((l) => l.layerName === 'goals');
    assert.ok(goals);
    assert.equal(goals.total, 2);
    assert.equal(goals.injected, 1);
    assert.equal(goals.trimmed, 1);
    const identity = report.layerPressure.byLayer.find((l) => l.layerName === 'identity');
    assert.ok(identity);
    assert.equal(identity.total, 1);
    assert.equal(identity.injected, 1);
  });

  it('formatAuditReport produces readable text', async () => {
    await logger.logInjection({
      idempotencyKey: 'fmt-1', projectId: 'p1', sessionId: 's1',
      injectionKind: 'reentry', sourceTurnId: null,
      built: createBuilt(), blockHash: null, status: 'injected',
    });
    await logger.flush();

    const report = await buildInjectionAuditReport(pool);
    const { title, output } = formatAuditReport(report);
    assert.equal(title, 'Context Injection Audit');
    assert.ok(output.includes('Summary'));
    assert.ok(output.includes('Provenance'));
    assert.ok(output.includes('Layer Pressure'));
    assert.ok(output.includes('Recall Relationship'));
    assert.ok(output.includes('Trim'));
  });

  it('session filter narrows results', async () => {
    await logger.logInjection({
      idempotencyKey: 'sess-1', projectId: 'p1', sessionId: 's1',
      injectionKind: 'reentry', sourceTurnId: null,
      built: createBuilt(), blockHash: null, status: 'injected',
    });
    await logger.logInjection({
      idempotencyKey: 'sess-2', projectId: 'p1', sessionId: 's2',
      injectionKind: 'reentry', sourceTurnId: null,
      built: createBuilt(), blockHash: null, status: 'injected',
    });
    await logger.flush();

    const allReport = await buildInjectionAuditReport(pool);
    assert.equal(allReport.summary.totalEvents, 2);

    const filteredReport = await buildInjectionAuditReport(pool, { sessionId: 's1' });
    assert.equal(filteredReport.summary.totalEvents, 1);
  });

  it('session-scopes recall relationship counts', async () => {
    await pool.query(`INSERT INTO memories (memory_type, content) VALUES ('episodic', 'one'), ('episodic', 'two')`);
    const memories = await pool.query(`SELECT id FROM memories ORDER BY id`);
    const ids = memories.rows.map((row: Record<string, unknown>) => Number(row.id));
    const builtFor = (id: number) => createBuilt({ items: [{
      layerName: 'memory', sourceKind: 'memory', sourceId: `memory:${id}`, memoryId: id,
      position: 0, selectionRank: 1, selectionScore: null, selectionReason: 'importance_rank',
      disposition: 'injected', provenanceGranularity: 'item', charCount: 3, metadata: {},
    }] });
    await logger.logInjection({ idempotencyKey: 'recall-s1', projectId: 'p1', sessionId: 's1',
      injectionKind: 'reentry', sourceTurnId: null, built: builtFor(ids[0]), blockHash: null, status: 'injected' });
    await logger.logInjection({ idempotencyKey: 'recall-s2', projectId: 'p1', sessionId: 's2',
      injectionKind: 'reentry', sourceTurnId: null, built: builtFor(ids[1]), blockHash: null, status: 'injected' });
    await logger.flush();
    await pool.query(`INSERT INTO memory_recall_events (memory_id, session_id, query_hash, source, rank)
      VALUES ($1, 's1', 's1-recall', 'search', 1), ($2, 's2', 's2-recall', 'search', 1)`, ids);
    const report = await buildInjectionAuditReport(pool, { sessionId: 's1' });
    assert.equal(report.recallRelationship.recalledMemories, 1);
    assert.equal(report.recallRelationship.recalledAndInjected, 1);
  });
});

describe('Context injection audit — PostgreSQL', () => {
  const PG_URL = process.env.CSM_DATABASE_URL ?? '';
  let pool: DatabasePool;

  beforeEach(async () => {
    if (!PG_URL) return;
    const { DEFAULT_CONFIG } = await import('../src/config.js');
    const db = new Database(DEFAULT_CONFIG);
    await db.connect();
    pool = db.getPool();
  });

  afterEach(async () => {
    if (!PG_URL) return;
    try { await pool.close(); } catch { /* closed */ }
  });

  it('same report shape as SQLite', { skip: !PG_URL }, async () => {
    const report = await buildInjectionAuditReport(pool);
    assert.ok(typeof report.summary.totalEvents === 'number');
    assert.ok(typeof report.provenance.totalItems === 'number');
    assert.ok(Array.isArray(report.layerPressure.byLayer));
    assert.ok(typeof report.recallRelationship.injectionRate === 'number' || report.recallRelationship.injectionRate === null);
  });
});

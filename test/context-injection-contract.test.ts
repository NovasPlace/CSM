import assert from 'node:assert/strict';
import { it, describe, before, after, beforeEach } from 'node:test';
import { mkdirSync, rmSync } from 'node:fs';
import { Database } from '../src/database.js';
import { ReEntryProtocol } from '../src/re-entry-protocol.js';
import {
  BUILDER_VERSION,
  computeConfigHash,
  validateBuiltContextInjection,
  type BuiltContextInjection,
  type ContextInjectionItem,
} from '../src/context-injection-contract.js';
import { DEFAULT_REENTRY_CONFIG } from '../src/reentry-contract.js';
import type { PluginConfig, DatabasePool } from '../src/types.js';

const SQLITE_DIR = '.tmp/sqlite-contract';
const SQLITE_PATH = `${SQLITE_DIR}/contract-test.sqlite`;

function createSqliteConfig(): PluginConfig {
  return {
    databaseUrl: SQLITE_PATH,
    databaseProvider: 'sqlite',
    sqlitePath: SQLITE_PATH,
    embeddingModel: 'nomic-embed-text',
    embeddingApiUrl: 'http://localhost:11434',
  } as PluginConfig;
}

function createMemoryRow(pool: DatabasePool, content: string, type: string, tags: string[], importance: number) {
  return pool.query(
    `INSERT INTO memories (session_id, memory_type, content, importance, tags)
     VALUES ('s-test', '${type}', '${content}', ${importance}, '${JSON.stringify(tags)}')
     RETURNING id`,
  );
}

describe('Context injection contract - re-entry provenance', () => {
  let db: Database;
  let pool: DatabasePool;
  let protocol: ReEntryProtocol;

  before(() => {
    try { mkdirSync(SQLITE_DIR, { recursive: true }); } catch { /* exists */ }
  });

  beforeEach(async () => {
    try { rmSync(SQLITE_PATH); } catch { /* not exists */ }
    try { rmSync(`${SQLITE_PATH}-wal`); } catch { /* not exists */ }
    try { rmSync(`${SQLITE_PATH}-shm`); } catch { /* not exists */ }
    db = new Database(createSqliteConfig());
    await db.connect();
    pool = db.getPool();

    await createMemoryRow(pool, 'Complete the API refactor', 'episodic', ['goal', 'decision'], 0.9);
    await createMemoryRow(pool, 'Use TypeScript strict mode', 'preference', ['preference'], 0.8);
    await createMemoryRow(pool, 'Never commit directly to main', 'lesson', ['constraint'], 0.95);
    await createMemoryRow(pool, 'Fixed the auth bug in login.ts', 'procedural', [], 0.6);

    const { MemoryManager } = await import('../src/memory-manager.js');
    const { SelfModelUpdater } = await import('../src/self-model-updater.js');
    const { BeliefKnowledgeConsolidator } = await import('../src/belief-knowledge-store.js');
    const { AgentWorkJournal } = await import('../src/agent-work-journal.js');
    const memoryManager = new MemoryManager(pool);
    const selfModel = new SelfModelUpdater(pool);
    const beliefStore = new BeliefKnowledgeConsolidator(pool);
    const workJournal = new AgentWorkJournal(pool);
    protocol = new ReEntryProtocol({
      pool, memoryManager, selfModel, beliefStore, workJournal,
      config: { ...DEFAULT_REENTRY_CONFIG, previewOnly: false },
    });
  });

  after(async () => {
    try { await db?.disconnect(); } catch { /* closed */ }
  });

  it('snapshot parity: buildBlock text == buildBlockWithProvenance text', async () => {
    const textOnly = await protocol.buildBlock('s-test', 'test-project');
    const withProv = await protocol.buildBlockWithProvenance('s-test', 'test-project');
    assert.ok(textOnly !== null, 'buildBlock must return text');
    assert.ok(withProv !== null, 'buildBlockWithProvenance must return result');
    assert.equal(withProv.text, textOnly, 'rendered text must be identical');
  });

  it('source-only turn parity: buildBlockForSourceOnlyTurn text == provenance text', async () => {
    const textOnly = await protocol.buildBlockForSourceOnlyTurn('s-test', 'test-project');
    const withProv = await protocol.buildBlockWithProvenance('s-test', 'test-project');
    assert.ok(textOnly !== null);
    assert.ok(withProv !== null);
    assert.equal(withProv.text, textOnly);
  });

  it('contract validity: text exists and is non-empty', async () => {
    const built = await protocol.buildBlockWithProvenance('s-test', 'test-project');
    assert.ok(built !== null);
    assert.ok(typeof built.text === 'string');
    assert.ok(built.text.length > 0);
  });

  it('contract validity: every item has valid disposition', async () => {
    const built = await protocol.buildBlockWithProvenance('s-test', 'test-project');
    assert.ok(built !== null);
    for (const item of built.items) {
      assert.ok(['injected', 'trimmed', 'omitted'].includes(item.disposition),
        `invalid disposition: ${item.disposition}`);
    }
  });

  it('contract validity: no duplicate (layerName, position)', async () => {
    const built = await protocol.buildBlockWithProvenance('s-test', 'test-project');
    assert.ok(built !== null);
    const seen = new Set<string>();
    for (const item of built.items) {
      const key = `${item.layerName}:${item.position}`;
      assert.ok(!seen.has(key), `duplicate (layerName, position): ${key}`);
      seen.add(key);
    }
  });

  it('contract validity: non-memory items have memoryId = null', async () => {
    const built = await protocol.buildBlockWithProvenance('s-test', 'test-project');
    assert.ok(built !== null);
    for (const item of built.items) {
      if (item.sourceKind !== 'memory') {
        assert.equal(item.memoryId, null,
          `non-memory item in ${item.layerName} has non-null memoryId`);
      }
    }
  });

  it('contract validity: provenance granularity is explicit', async () => {
    const built = await protocol.buildBlockWithProvenance('s-test', 'test-project');
    assert.ok(built !== null);
    for (const item of built.items) {
      assert.ok(['item', 'layer'].includes(item.provenanceGranularity),
        `invalid provenanceGranularity: ${item.provenanceGranularity}`);
    }
  });

  it('contract validity: validateBuiltContextInjection returns no errors', async () => {
    const built = await protocol.buildBlockWithProvenance('s-test', 'test-project');
    assert.ok(built !== null);
    const errors = validateBuiltContextInjection(built);
    assert.deepEqual(errors, []);
  });

  it('deterministic build: same inputs produce same text and items', async () => {
    const a = await protocol.buildBlockWithProvenance('s-test', 'test-project');
    const b = await protocol.buildBlockWithProvenance('s-test', 'test-project');
    assert.ok(a !== null && b !== null);
    assert.equal(a.text, b.text);
    assert.equal(a.items.length, b.items.length);
    assert.deepEqual(a.items.map((item) => item.layerName), b.items.map((item) => item.layerName));
  });

  it('builder version is set', async () => {
    const built = await protocol.buildBlockWithProvenance('s-test', 'test-project');
    assert.ok(built !== null);
    assert.equal(built.builderVersion, BUILDER_VERSION);
  });

  it('config hash is deterministic', async () => {
    const a = await protocol.buildBlockWithProvenance('s-test', 'test-project');
    const b = await protocol.buildBlockWithProvenance('s-test', 'test-project');
    assert.ok(a !== null && b !== null);
    assert.equal(a.configHash, b.configHash);
    assert.ok(a.configHash.startsWith('cfg_'));
  });

  it('injectionKind is reentry', async () => {
    const built = await protocol.buildBlockWithProvenance('s-test', 'test-project');
    assert.ok(built !== null);
    assert.equal(built.injectionKind, 'reentry');
  });

  it('layer summaries are present for all layers', async () => {
    const built = await protocol.buildBlockWithProvenance('s-test', 'test-project');
    assert.ok(built !== null);
    assert.ok(built.layers.length > 0);
    for (const layer of built.layers) {
      assert.ok(['included', 'trimmed', 'dropped'].includes(layer.status));
      assert.ok(layer.finalChars >= 0);
      assert.ok(layer.originalChars >= 0);
    }
  });

  it('disabled protocol returns null', async () => {
    const { MemoryManager } = await import('../src/memory-manager.js');
    const { SelfModelUpdater } = await import('../src/self-model-updater.js');
    const { BeliefKnowledgeConsolidator } = await import('../src/belief-knowledge-store.js');
    const { AgentWorkJournal } = await import('../src/agent-work-journal.js');
    const disabled = new ReEntryProtocol({
      pool, memoryManager: new MemoryManager(pool),
      selfModel: new SelfModelUpdater(pool),
      beliefStore: new BeliefKnowledgeConsolidator(pool),
      workJournal: new AgentWorkJournal(pool),
      config: { enabled: false },
    });
    const result = await disabled.buildBlockWithProvenance('s-test', 'test-project');
    assert.equal(result, null);
  });

  it('empty database produces valid (but sparse) provenance', async () => {
    try { rmSync(`${SQLITE_DIR}/empty.sqlite`); } catch { /* not exists */ }
    const emptyConfig = createSqliteConfig();
    (emptyConfig as { sqlitePath: string }).sqlitePath = `${SQLITE_DIR}/empty.sqlite`;
    (emptyConfig as { databaseUrl: string }).databaseUrl = `${SQLITE_DIR}/empty.sqlite`;
    const emptyDb = new Database(emptyConfig);
    await emptyDb.connect();
    const emptyPool = emptyDb.getPool();
    const { MemoryManager } = await import('../src/memory-manager.js');
    const { SelfModelUpdater } = await import('../src/self-model-updater.js');
    const { BeliefKnowledgeConsolidator } = await import('../src/belief-knowledge-store.js');
    const { AgentWorkJournal } = await import('../src/agent-work-journal.js');
    const emptyProtocol = new ReEntryProtocol({
      pool: emptyPool, memoryManager: new MemoryManager(emptyPool),
      selfModel: new SelfModelUpdater(emptyPool),
      beliefStore: new BeliefKnowledgeConsolidator(emptyPool),
      workJournal: new AgentWorkJournal(emptyPool),
    });
    const built = await emptyProtocol.buildBlockWithProvenance('s-empty', 'empty-project');
    await emptyDb.disconnect();
    assert.ok(built !== null);
    const errors = validateBuiltContextInjection(built);
    assert.deepEqual(errors, []);
  });
});

describe('Context injection contract - validateBuiltContextInjection', () => {
  it('rejects non-string text', () => {
    const errors = validateBuiltContextInjection({
      text: 123 as unknown as string,
      injectionKind: 'reentry',
      items: [], layers: [], charCount: 0, estimatedTokens: 0,
      trimLevel: 'none', builderVersion: 'v1', configHash: 'h',
      metadata: {},
    });
    assert.ok(errors.includes('text must be a string'));
  });

  it('rejects duplicate (layerName, position)', () => {
    const errors = validateBuiltContextInjection({
      text: 'ok',
      injectionKind: 'reentry',
      items: [
        { layerName: 'goals', sourceKind: 'memory', sourceId: 'm:1', memoryId: 1,
          position: 0, selectionRank: 0, selectionScore: 0.5, selectionReason: 'importance_rank',
          disposition: 'injected', provenanceGranularity: 'item', charCount: 10, metadata: {} },
        { layerName: 'goals', sourceKind: 'memory', sourceId: 'm:2', memoryId: 2,
          position: 0, selectionRank: 1, selectionScore: 0.4, selectionReason: 'importance_rank',
          disposition: 'injected', provenanceGranularity: 'item', charCount: 10, metadata: {} },
      ],
      layers: [], charCount: 2, estimatedTokens: 1,
      trimLevel: 'none', builderVersion: 'v1', configHash: 'h',
      metadata: {},
    });
    assert.ok(errors.some((e) => e.includes('duplicate')));
  });

  it('rejects memory sourceKind with null memoryId', () => {
    const errors = validateBuiltContextInjection({
      text: 'ok',
      injectionKind: 'reentry',
      items: [
        { layerName: 'goals', sourceKind: 'memory', sourceId: 'm:1', memoryId: null,
          position: 0, selectionRank: 0, selectionScore: 0.5, selectionReason: 'importance_rank',
          disposition: 'injected', provenanceGranularity: 'item', charCount: 10, metadata: {} },
      ],
      layers: [], charCount: 10, estimatedTokens: 3,
      trimLevel: 'none', builderVersion: 'v1', configHash: 'h',
      metadata: {},
    });
    assert.ok(errors.some((e) => e.includes('memory sourceKind with null memoryId')));
  });

  it('rejects non-memory sourceKind with non-null memoryId', () => {
    const errors = validateBuiltContextInjection({
      text: 'ok',
      injectionKind: 'reentry',
      items: [
        { layerName: 'identity', sourceKind: 'derived_state', sourceId: 'session', memoryId: 42,
          position: 0, selectionRank: null, selectionScore: null, selectionReason: null,
          disposition: 'injected', provenanceGranularity: 'layer', charCount: 10, metadata: {} },
      ],
      layers: [], charCount: 10, estimatedTokens: 3,
      trimLevel: 'none', builderVersion: 'v1', configHash: 'h',
      metadata: {},
    });
    assert.ok(errors.some((e) => e.includes('non-memory sourceKind with non-null memoryId')));
  });

  it('accepts valid built injection', () => {
    const errors = validateBuiltContextInjection({
      text: 'ok',
      injectionKind: 'reentry',
      items: [
        { layerName: 'goals', sourceKind: 'memory', sourceId: 'm:1', memoryId: 1,
          position: 0, selectionRank: 0, selectionScore: 0.5, selectionReason: 'importance_rank',
          disposition: 'injected', provenanceGranularity: 'item', charCount: 10, metadata: {} },
        { layerName: 'identity', sourceKind: 'derived_state', sourceId: 'session', memoryId: null,
          position: 0, selectionRank: null, selectionScore: null, selectionReason: null,
          disposition: 'injected', provenanceGranularity: 'layer', charCount: 20, metadata: {} },
      ],
      layers: [], charCount: 30, estimatedTokens: 8,
      trimLevel: 'none', builderVersion: 'v1', configHash: 'h',
      metadata: {},
    });
    assert.deepEqual(errors, []);
  });
});

describe('Context injection contract - computeConfigHash', () => {
  it('produces deterministic hash', () => {
    const a = computeConfigHash({ maxChars: 2100, layers: 'a,b,c' });
    const b = computeConfigHash({ maxChars: 2100, layers: 'a,b,c' });
    assert.equal(a, b);
  });

  it('produces different hash for different config', () => {
    const a = computeConfigHash({ maxChars: 2100, layers: 'a,b,c' });
    const b = computeConfigHash({ maxChars: 1000, layers: 'a,b,c' });
    assert.notEqual(a, b);
  });

  it('produces cfg_ prefixed hex string', () => {
    const hash = computeConfigHash({ maxChars: 2100 });
    assert.ok(hash.startsWith('cfg_'));
    assert.ok(/^cfg_[0-9a-f]{8}$/.test(hash));
  });
});

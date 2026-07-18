import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ContextRecallSelector } from '../dist/context-recall-selector.js';
import { rankMemoriesByProvenance } from '../dist/bridge-provenance.js';
import { applyWeights, deduplicateByContent, recencyScoreForAge } from '../dist/hybrid-search-ranking.js';
import { DEFAULT_WEIGHTS } from '../dist/hybrid-search-types.js';
import { vectorSearch } from '../dist/hybrid-search-sources.js';
import { MemoryManager } from '../dist/memory-manager.js';
import { computeReentryTrimLevel } from '../dist/re-entry-protocol.js';
import { migrateEmbeddingDimensions } from '../dist/schema/embedding-dimension-migration.js';
import { resolveOwnedPath } from '../dist/wiki-export-files.js';
import { buildMemoryQuery } from '../dist/wiki-export-memory-query.js';
import { buildExportPlan } from '../dist/wiki-export-plan.js';

describe('CSM correction contracts', () => {
  it('parameterizes the wiki importance threshold', () => {
    const query = buildMemoryQuery('pg', {
      mode: 'curated', importanceThreshold: 0.73, includeLinked: false, projectId: 'alpha',
    });
    assert.deepEqual(query.params, ['alpha', 0.73]);
    assert.match(query.sql, /importance >= \$2/);
    assert.doesNotMatch(query.sql, /importance >= 0\.73/);
  });

  it('rejects manifest paths outside the wiki output root', () => {
    assert.throws(() => resolveOwnedPath('C:\\wiki', '..\\outside.md'), /Unsafe wiki manifest path/);
    assert.throws(() => resolveOwnedPath('C:\\wiki', 'C:\\outside.md'), /Unsafe wiki manifest path/);
    assert.match(resolveOwnedPath('C:\\wiki', 'lessons/mem-1.md'), /mem-1\.md$/);
  });

  it('classifies dry-run updates and removals against the prior manifest', () => {
    const existing = {
      schemaVersion: 1 as const, exportedAt: '', mode: 'curated' as const,
      databaseManifest: 'old',
      notes: {
        'lessons/mem-1.md': { path: 'lessons/mem-1.md', contentHash: 'old-hash' },
        'memories/mem-2.md': { path: 'memories/mem-2.md', contentHash: 'removed-hash' },
      },
    };
    const plan = buildExportPlan([{ path: 'lessons/mem-1.md', content: 'changed' }], existing, true);
    assert.deepEqual(plan.update, ['lessons/mem-1.md']);
    assert.deepEqual(plan.remove, ['memories/mem-2.md']);
  });

  it('uses an actual one-week recency half-life', () => {
    assert.ok(Math.abs(recencyScoreForAge(168) - 0.5) < 1e-12);
    assert.ok(Math.abs(recencyScoreForAge(336) - 0.25) < 1e-12);
  });

  it('normalizes retrieval channels before applying weights', () => {
    const scores = applyWeights(
      new Map([[1, 0.016]]), new Map(), new Map([[2, 2]]), new Map(), DEFAULT_WEIGHTS,
    );
    assert.equal(scores.get(1), DEFAULT_WEIGHTS.vector);
    assert.equal(scores.get(2), DEFAULT_WEIGHTS.entity);
  });

  it('applies explicit legacy and global scopes to hybrid retrieval', async () => {
    const queries: string[] = [];
    const database = {
      dialect: 'pg',
      getPool: () => ({ query: async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      } }),
    };
    await vectorSearch(database as never, [0.1], 5, 'alpha', undefined, undefined, undefined, 'legacy');
    await vectorSearch(database as never, [0.1], 5, 'alpha', undefined, undefined, undefined, 'global');
    assert.match(queries[0], /project_id = \$3 OR project_id IS NULL/);
    assert.doesNotMatch(queries[1], /project_id/);
  });

  it('keeps distinct candidates when content rows are missing', async () => {
    const database = fakeDatabase([{ id: 1, content: 'same content' }]);
    const result = await deduplicateByContent(database as never, [[1, 3], [2, 2], [3, 1]]);
    assert.deepEqual(result.map(([id]) => id), [1, 2, 3]);
  });

  it('does not classify missing re-entry sources as aggressive trimming', () => {
    const missing = layer('missing_source', true, false);
    assert.equal(computeReentryTrimLevel([missing]), 'none');
    assert.equal(computeReentryTrimLevel([layer('over_budget', true, false)]), 'aggressive');
    assert.equal(computeReentryTrimLevel([layer('over_budget', false, true)]), 'soft');
  });

  it('rotates deterministic recall and resets a depleted tier', async () => {
    const calls: string[] = [];
    const pool = fakePool(async (sql) => {
      calls.push(sql);
      return { rows: sql.includes('ANY(') ? [] : [memoryRow(7)], rowCount: 1 };
    });
    const selector = new ContextRecallSelector(pool as never);
    selector.setProject('alpha');
    assert.deepEqual((await selector.procedural()).map(memory => memory.id), [7]);
    assert.deepEqual((await selector.procedural()).map(memory => memory.id), [7]);
    assert.equal(calls.length, 3);
    assert.ok(calls.every(sql => !sql.includes('RANDOM()')));
  });

  it('performs embedding dimension changes only through the ledgered migration', async () => {
    const sql: string[] = [];
    const pool = fakePool(async (text, params) => {
      sql.push(text);
      if (text.includes('atttypmod') && params?.[1] === 'embedding') {
        return { rows: [{ dimensions: 1536 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    await migrateEmbeddingDimensions(pool as never, 768);
    assert.ok(sql.some(text => text.includes('RENAME COLUMN embedding TO embedding_legacy_1536_before_768')));
    assert.equal(sql.filter(text => text.includes('ADD COLUMN embedding VECTOR(768)')).length, 2);
    assert.ok(sql.some(text => text.includes('DROP INDEX IF EXISTS idx_memory_chunks_embedding_hnsw')));
    assert.equal(sql.some(text => text.includes('atttypmod - 4')), false);
    assert.equal(sql.filter(text => text.includes('DROP NOT NULL')).length, 2);
  });

  it('repairs values preserved by the prior pgvector typmod bug', async () => {
    const sql: string[] = [];
    const pool = fakePool(async (text, params) => {
      sql.push(text);
      if (text.includes('atttypmod') && params?.[1] === 'embedding') {
        return { rows: [{ dimensions: 768 }], rowCount: 1 };
      }
      if (text.includes('atttypmod') && params?.[1] === 'embedding_legacy_764_before_768') {
        return { rows: [{ dimensions: 768 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    await migrateEmbeddingDimensions(pool as never, 768);
    assert.equal(sql.filter(text => text.startsWith('UPDATE ')).length, 2);
    assert.equal(sql.filter(text => text.includes('DROP NOT NULL')).length, 2);
    assert.equal(sql.some(text => text.includes('RENAME COLUMN')), false);
  });

  it('keeps failed chunk writes eligible for embedding backfill retry', async () => {
    const calls: string[] = [];
    const pool = fakePool(async (sql) => {
      calls.push(sql);
      if (sql.startsWith('SELECT id, content')) return { rows: [{ id: 9, content: 'retry me' }], rowCount: 1 };
      if (sql.startsWith('INSERT INTO memory_chunks')) throw new Error('chunk unavailable');
      return { rows: [], rowCount: 0 };
    });
    const database = { dialect: 'pg', getPool: () => pool };
    const embeddings = {
      generate: async () => new Array(768).fill(0.1),
      getProviderInfo: () => ({ provider: 'ollama', model: 'test' }),
    };
    const manager = new MemoryManager(database as never, embeddings as never);
    const result = await manager.backfillMissingEmbeddings({ limit: 1 });
    assert.equal(result.updated, 0);
    assert.equal(result.failed, 1);
    assert.equal(calls.some(sql => sql.startsWith('UPDATE memories SET embedding')), false);
  });

  it('ranks string timestamps and exact ties deterministically', () => {
    const older = bridgeMemory(1, '2026-07-17T00:00:00.000Z');
    const newer = bridgeMemory(2, '2026-07-18T00:00:00.000Z');
    const tied = bridgeMemory(3, '2026-07-18T00:00:00.000Z');
    const ranked = rankMemoriesByProvenance([older, newer, tied] as never);
    assert.deepEqual(ranked.map(memory => memory.id), [3, 2, 1]);
  });
});

function fakePool(query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>) {
  return { query: mock.fn(query), connect: mock.fn(), end: mock.fn() };
}

function fakeDatabase(rows: unknown[]) {
  return { getPool: () => ({ query: async () => ({ rows, rowCount: rows.length }) }) };
}

function layer(trimReason: 'missing_source' | 'over_budget', dropped: boolean, trimmed: boolean) {
  return {
    name: 'goals', priority: 1, budget: 10, chars: 0, originalChars: 0,
    text: '', trimmed, dropped, sources: [], trimReason,
  };
}

function memoryRow(id: number) {
  const now = new Date().toISOString();
  return {
    id, memory_type: 'lesson', content: 'lesson', importance: 1, emotion: 'neutral',
    confidence: 1, source: 'manual', tags: [], linked_memory_ids: [], metadata: {},
    created_at: now, updated_at: now, accessed_at: now, access_count: 0,
  };
}

function bridgeMemory(id: number, createdAt: string) {
  return {
    id, sessionId: 's', projectId: 'p', memoryType: 'lesson', content: `memory ${id}`,
    importance: 0.8, emotion: 'neutral', confidence: 1, source: 'manual', tags: [],
    linkedMemoryIds: [], metadata: {}, createdAt, updatedAt: createdAt, accessedAt: createdAt,
    accessCount: 0,
  };
}

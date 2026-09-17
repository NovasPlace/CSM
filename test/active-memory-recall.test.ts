import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { ContextRecallSelector } from '../dist/context-recall-selector.js';
import { Database } from '../dist/database.js';
import { EmbeddingGenerator } from '../dist/embeddings.js';
import { vectorSearch } from '../dist/hybrid-search-sources.js';
import { getRelatedMemories } from '../dist/memory-graph.js';
import { MemoryManager } from '../dist/memory-manager.js';
import { PrimingEngine } from '../dist/priming-engine.js';
import type { PluginConfig } from '../dist/types.js';

const tempDir = '.tmp/active-memory-recall';
const dbPath = `${tempDir}/recall.sqlite`;

function removeDatabase(): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { rmSync(path); } catch { /* absent */ }
  }
}

function sqliteConfig(): PluginConfig {
  return {
    databaseUrl: dbPath,
    databaseProvider: 'sqlite',
    sqlitePath: dbPath,
    embeddingModel: 'nomic-embed-text',
    embeddingApiUrl: 'http://localhost:11434',
  } as PluginConfig;
}

describe('active-memory recall invariant', () => {
  beforeEach(() => {
    mkdirSync(tempDir, { recursive: true });
    removeDatabase();
  });

  afterEach(() => {
    removeDatabase();
    try { rmSync(tempDir); } catch { /* absent */ }
  });

  it('keeps archived and superseded rows out of SQLite search, list, cascade, and graph recall', async () => {
    const config = sqliteConfig();
    const db = new Database(config);
    await db.connect();
    try {
      const manager = new MemoryManager(db, new EmbeddingGenerator(config));
      const projectId = 'active-recall-project';
      const sessionId = 'active-recall-session';
      await manager.createSession(sessionId, projectId);

      const active = await manager.saveMemory({
        sessionId,
        projectId,
        content: 'recall-invariant needle active memory',
        type: 'workspace',
        source: 'manual',
      });
      const archived = await manager.saveMemory({
        sessionId,
        projectId,
        content: 'recall-invariant needle archived memory',
        type: 'workspace',
        source: 'manual',
      });
      const superseded = await manager.saveMemory({
        sessionId,
        projectId,
        content: 'recall-invariant needle superseded memory',
        type: 'workspace',
        source: 'manual',
      });

      await db.getPool().query(
        "UPDATE memories SET archived_at = datetime('now'), archive_reason = 'test' WHERE id = $1",
        [archived.id],
      );
      await db.getPool().query(
        "UPDATE memories SET superseded_by = $1, superseded_at = datetime('now') WHERE id = $2",
        [active.id, superseded.id],
      );

      const search = await manager.searchMemories({
        query: 'recall-invariant needle',
        projectId,
        searchMode: 'project',
        limit: 10,
      });
      assert.deepEqual(search.map((entry) => entry.memory.id), [active.id]);

      const list = await manager.listMemories({ projectId, searchMode: 'project', limit: 10 });
      assert.deepEqual(list.map((memory) => memory.id), [active.id]);

      const priming = new PrimingEngine(db);
      await priming.linkMemories(active.id, archived.id);
      await priming.linkMemories(active.id, superseded.id);
      const cascade = await priming.cascade(active.id, { projectId, searchMode: 'project' });
      assert.deepEqual(cascade.memories.map((memory) => memory.id), [active.id]);
      assert.deepEqual(await priming.getLinkedMemories(active.id), []);

      await db.getPool().query(
        `INSERT INTO memory_links (source_id, target_id, link_type, shared_entities, strength)
         VALUES ($1, $2, 'reference', $3, 1), ($1, $4, 'reference', $3, 1)
         ON CONFLICT DO NOTHING`,
        [active.id, archived.id, JSON.stringify([]), superseded.id],
      );
      assert.deepEqual(await getRelatedMemories(db, active.id, 10, { projectId }), []);
      assert.deepEqual(await getRelatedMemories(db, archived.id, 10, { projectId }), []);
    } finally {
      await db.close();
    }
  });

  it('adds active-memory predicates to hybrid vector retrieval', async () => {
    const queries: string[] = [];
    const db = {
      dialect: 'pg',
      getPool: () => ({
        query: mock.fn(async (sql: string) => {
          queries.push(sql);
          return { rows: [], rowCount: 0 };
        }),
      }),
    };

    await vectorSearch(db as never, [0.1], 5, 'alpha', undefined, undefined, undefined, 'project');
    assert.match(queries[0] ?? '', /superseded_by IS NULL/);
    assert.match(queries[0] ?? '', /archived_at IS NULL/);
  });

  it('adds active-memory predicates to automatic context recall', async () => {
    const queries: string[] = [];
    const pool = {
      query: mock.fn(async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      }),
    };
    const selector = new ContextRecallSelector(pool as never);
    selector.setProject('alpha');
    await selector.procedural();

    assert.match(queries[0] ?? '', /superseded_by IS NULL/);
    assert.match(queries[0] ?? '', /archived_at IS NULL/);
  });
});

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { Database } from '../dist/database.js';
import { EmbeddingGenerator } from '../dist/embeddings.js';
import { getRelatedMemories } from '../dist/memory-graph.js';
import { MemoryManager } from '../dist/memory-manager.js';
import { PrimingEngine } from '../dist/priming-engine.js';
import type { PluginConfig } from '../dist/types.js';

const tempDir = '.tmp/sqlite-memory-graph';
const dbPath = `${tempDir}/graph.sqlite`;

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

describe('SQLite memory graph', () => {
  beforeEach(() => {
    mkdirSync(tempDir, { recursive: true });
    removeDatabase();
  });

  afterEach(() => {
    removeDatabase();
    try { rmSync(tempDir); } catch { /* absent */ }
  });

  it('links two saved memories with a shared extracted file concept', async () => {
    const config = sqliteConfig();
    const db = new Database(config);
    await db.connect();
    const manager = new MemoryManager(db, new EmbeddingGenerator(config));
    await manager.createSession('sqlite-graph-session', 'sqlite-graph-project');

    const first = await manager.saveMemory({
      sessionId: 'sqlite-graph-session',
      projectId: 'sqlite-graph-project',
      content: 'Investigated src/shared.ts before the repair.',
      type: 'episodic',
      source: 'manual',
    });
    const second = await manager.saveMemory({
      sessionId: 'sqlite-graph-session',
      projectId: 'sqlite-graph-project',
      content: 'Fixed src/shared.ts and recorded the result.',
      type: 'episodic',
      source: 'manual',
    });

    const related = await getRelatedMemories(db, second.id);
    assert.equal(related.length, 1);
    assert.equal(related[0]?.memory.id, first.id);
    assert.ok(related[0]?.link.shared_entities.includes('src/shared.ts'));

    const reverseRelated = await getRelatedMemories(db, first.id);
    assert.equal(reverseRelated[0]?.memory.id, second.id);

    const priming = new PrimingEngine(db);
    await priming.linkMemories(first.id, second.id);
    const linked = await priming.getLinkedMemories(first.id);
    assert.equal(linked[0]?.id, second.id);
    assert.ok(linked[0]?.accessedAt instanceof Date);
    await priming.unlinkMemories(first.id, second.id);
    assert.equal((await priming.getLinkedMemories(first.id)).length, 0);

    await db.getPool().query("UPDATE memories SET created_at = datetime('now', '-1 day') WHERE id = $1", [first.id]);
    const recentMemories = await manager.getRecentProjectMemories('sqlite-graph-project');
    assert.equal(recentMemories[0]?.id, second.id);

    await manager.createSession('sqlite-older-session', 'sqlite-graph-project');
    await db.getPool().query("UPDATE sessions SET updated_at = datetime('now', '-1 day') WHERE id = $1", ['sqlite-older-session']);
    const recentSessions = await manager.getRecentProjectSessions('sqlite-graph-project');
    assert.equal(recentSessions[0]?.id, 'sqlite-graph-session');
    await db.close();
  });
});

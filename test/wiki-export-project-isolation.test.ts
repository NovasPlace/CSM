import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '../dist/database.js';
import { EmbeddingGenerator } from '../dist/embeddings.js';
import { exportWiki } from '../dist/wiki-export.js';
import { wikiExportTool } from '../dist/wiki-export-tool.js';
import { MemoryManager } from '../dist/memory-manager.js';
import type { PluginConfig } from '../dist/types.js';

const tempDir = '.tmp/wiki-export-isolation';
const dbPath = `${tempDir}/memory.sqlite`;
const outputDir = `${tempDir}/wiki`;

function config(): PluginConfig {
  return {
    databaseUrl: dbPath,
    databaseProvider: 'sqlite',
    sqlitePath: dbPath,
    embeddingModel: 'nomic-embed-text',
    embeddingApiUrl: 'http://localhost:11434',
  } as PluginConfig;
}

function allFileText(directory: string): string {
  const chunks: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) chunks.push(allFileText(path));
    else chunks.push(readFileSync(path, 'utf8'));
  }
  return chunks.join('\n');
}

describe('wiki export project isolation', () => {
  beforeEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('exports only the bound project even when a historical cross-project link exists', async () => {
    const db = new Database(config());
    await db.connect();
    const manager = new MemoryManager(db, new EmbeddingGenerator(config()));
    await manager.createSession('wiki-session-a', 'wiki-project-a');
    await manager.createSession('wiki-session-b', 'wiki-project-b');
    const memoryA = await manager.saveMemory({
      sessionId: 'wiki-session-a',
      content: 'Project A public export proof.',
      type: 'lesson',
      source: 'manual',
    });
    const memoryB = await manager.saveMemory({
      sessionId: 'wiki-session-b',
      content: 'PROJECT_B_PRIVATE_EXPORT_SENTINEL',
      type: 'lesson',
      source: 'manual',
    });
    await db.getPool().query(
      `INSERT INTO memory_links
         (source_id, target_id, link_type, shared_entities, strength)
       VALUES ($1, $2, 'reference', $3, 1)`,
      [memoryA.id, memoryB.id, JSON.stringify(['cross-project-corruption'])],
    );

    const result = await exportWiki(db, {
      outputDir,
      projectId: 'wiki-project-a',
      mode: 'full',
      includeLinked: true,
      incremental: false,
    });

    assert.equal(result.totalEligible, 1);
    assert.match(allFileText(outputDir), /Project A public export proof/);
    assert.doesNotMatch(allFileText(outputDir), /PROJECT_B_PRIVATE_EXPORT_SENTINEL/);
    assert.equal('projectId' in wikiExportTool(db, 'wiki-project-a').args, false);
    await db.close();
  });
});

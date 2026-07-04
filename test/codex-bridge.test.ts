import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { CodexMemoryBridge } from '../dist/codex-bridge.js';
import { ContextRecallDaemon } from '../dist/context-recall.js';
import { Database } from '../dist/database.js';
import { EmbeddingGenerator } from '../dist/embeddings.js';
import { MemoryManager } from '../dist/memory-manager.js';
import { PrimingEngine } from '../dist/priming-engine.js';
import { memoryContextTool, memorySaveTool, memorySearchTool } from '../dist/tools.js';
import type { PluginConfig } from '../dist/types.js';

const BASE_DB_URL = process.env.DATABASE_URL
  ?? 'postgresql://postgres:postgres@localhost:5432/cross_session_memory';

function buildAdminUrl(dbUrl: string): string {
  const url = new URL(dbUrl);
  url.pathname = '/postgres';
  return url.toString();
}

function buildTempDbUrl(dbUrl: string, dbName: string): string {
  const url = new URL(dbUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

describe('Phase 20 - Codex bridge adapter', () => {
  const tempDbName = `cross_session_memory_codex_bridge_${Date.now()}`;
  const databaseUrl = buildTempDbUrl(BASE_DB_URL, tempDbName);
  const adminPool = new Pool({ connectionString: buildAdminUrl(BASE_DB_URL) });
  const config: PluginConfig = {
    databaseUrl,
    databaseProvider: 'postgres',
    sqlitePath: '.data/csm-memory.db',
    embeddingModel: 'nomic-embed-text',
    embeddingApiUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434',
  } as PluginConfig;

  let bridge: CodexMemoryBridge;
  let db: Database;
  let memoryManager: MemoryManager;
  let contextRecall: ContextRecallDaemon;
  let primingEngine: PrimingEngine;

  before(async () => {
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(tempDbName)}`);
    bridge = await CodexMemoryBridge.connect(config);
    db = new Database(config);
    await db.connect();
    memoryManager = new MemoryManager(db, new EmbeddingGenerator(config));
    contextRecall = new ContextRecallDaemon(db, 90);
    primingEngine = new PrimingEngine(db);
    await memoryManager.createSession('opencode-phase20', 'phase20-project');
    contextRecall.setSession('opencode-phase20', 'phase20-project');
  });

  after(async () => {
    await bridge.disconnect();
    await db.close();
    await adminPool.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1
         AND pid <> pg_backend_pid()`,
      [tempDbName],
    );
    await adminPool.query(`DROP DATABASE ${quoteIdentifier(tempDbName)}`);
    await adminPool.end();
  });

  it('returns a compact context brief and relevant lessons for a Codex task', async () => {
    await bridge.saveMemory({
      projectRoot: 'phase20-project',
      content: 'Use parameterized SQL in bridge adapters and never store raw queries.',
      type: 'lesson',
      tags: ['risk_rule', 'sql'],
    });
    await bridge.saveMemory({
      projectRoot: 'phase20-project',
      content: 'Edited src/codex-bridge.ts to expose get_context_brief for Codex.',
      type: 'workspace',
      tags: ['bridge'],
    });

    const brief = await bridge.getContextBrief({
      projectRoot: 'phase20-project',
      task: 'bridge get_context_brief should recall SQL safety lessons',
    });

    assert.equal(brief.available, true);
    assert.ok(brief.brief?.compressed.includes('Project Context') || brief.brief?.compressed.length);
    assert.ok(brief.lessons.some((memory) => memory.content.includes('parameterized SQL')));
    assert.ok(bridge.listTools().includes('get_context_brief'));
  });

  it('shares the same save and search paths as the OpenCode tool wrappers', async () => {
    const saveTool = memorySaveTool(memoryManager);
    const searchTool = memorySearchTool(memoryManager, primingEngine);

    await saveTool.execute({
      content: 'OpenCode wrapper stored the bridge parity token.',
      type: 'workspace',
    }, { sessionID: 'opencode-phase20' });

    await bridge.saveMemory({
      projectRoot: 'phase20-project',
      content: 'Codex bridge stored the bridge parity token as well.',
      type: 'workspace',
    });

    const bridgeResults = await bridge.searchMemories({
      query: 'bridge parity token',
      projectId: 'phase20-project',
      sessionId: 'opencode-phase20',
      limit: 5,
    });
    const toolResults = await searchTool.execute({
      query: 'bridge parity token',
      limit: 5,
    }, { sessionID: 'opencode-phase20' });

    assert.ok(bridgeResults.results.length >= 2);
    assert.equal(toolResults.metadata.count >= 2, true);
  });

  it('keeps bridge context readable through the existing OpenCode context tool', async () => {
    const contextTool = memoryContextTool(contextRecall);
    await contextRecall.refreshSession('opencode-phase20', 'phase20-project');

    const result = await contextTool.execute({}, { sessionID: 'opencode-phase20' });
    assert.equal(result.metadata.available, true);
    assert.match(result.output, /CROSS-SESSION MEMORY CONTEXT/);
  });

  it('supports explicit maintenance and prune dry-run without startup side effects', async () => {
    const memory = await bridge.saveMemory({
      projectRoot: 'phase20-project',
      content: 'Bridge backfill target token phase20BackfillToken.',
      type: 'workspace',
    });
    await db.getPool().query('UPDATE memories SET embedding = NULL WHERE id = $1', [memory.id]);

    const dryRun = await bridge.backfillMissingEmbeddings({
      limit: 10,
      projectId: 'phase20-project',
      dryRun: true,
    });
    const prune = await bridge.pruneMemoriesDryRun();

    assert.ok(dryRun.eligible >= 1);
    assert.equal(prune.dryRun, true);
  });
});

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { Database } from '../dist/database.js';
import { MemoryManager } from '../dist/memory-manager.js';
import { EmbeddingGenerator } from '../dist/embeddings.js';
import { vectorSearch } from '../dist/hybrid-search.js';
import { ContextRecallDaemon } from '../dist/context-recall.js';
import { hashRecallQuery } from '../dist/recall-telemetry.js';
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

describe('Phase 19b — backfill and recall telemetry', () => {
  const tempDbName = `cross_session_memory_phase19b_${Date.now()}`;
  const adminPool = new Pool({ connectionString: buildAdminUrl(BASE_DB_URL) });
  const config: PluginConfig = {
    databaseUrl: buildTempDbUrl(BASE_DB_URL, tempDbName),
    databaseProvider: 'postgres',
    sqlitePath: '.data/csm-memory.db',
    embeddingModel: 'test-hash',
    embeddingDimensions: 768,
  } as PluginConfig;

  let db: Database;
  let memoryManager: MemoryManager;
  let embeddings: EmbeddingGenerator;
  let contextRecall: ContextRecallDaemon;

  before(async () => {
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(tempDbName)}`);
    db = new Database(config);
    await db.connect();
    embeddings = new EmbeddingGenerator(config);
    memoryManager = new MemoryManager(db, embeddings);
    contextRecall = new ContextRecallDaemon(db, 90);
    await memoryManager.createSession('phase19b-session', 'phase19b-project');
  });

  after(async () => {
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

  it('backfills null embeddings explicitly and restores vector searchability', async () => {
    const memory = await memoryManager.saveMemory({
      sessionId: 'phase19b-session',
      content: 'Vector backfill target uses phase19bUniqueToken for recall.',
      type: 'workspace',
      importance: 0.8,
      source: 'manual',
    });
    const pool = db.getPool();

    await pool.query('UPDATE memories SET embedding = NULL WHERE id = $1', [memory.id]);
    await pool.query('DELETE FROM memory_chunks WHERE memory_id = $1', [memory.id]);

    const queryEmbedding = await embeddings.generate('phase19bUniqueToken');
    const before = await vectorSearch(db, queryEmbedding, 5, 'phase19b-project');
    assert.equal(before.some((row) => row.id === memory.id), false);

    const dryRun = await memoryManager.backfillMissingEmbeddings({
      limit: 10,
      dryRun: true,
    });
    assert.ok(dryRun.eligible >= 1);
    assert.equal(dryRun.updated, 0);

    const backfill = await memoryManager.backfillMissingEmbeddings({
      limit: 10,
      projectId: 'phase19b-project',
    });
    assert.ok(backfill.updated >= 1);
    assert.equal(backfill.failed, 0);

    const after = await vectorSearch(db, queryEmbedding, 5, 'phase19b-project');
    assert.equal(after.some((row) => row.id === memory.id), true);
  });

  it('stores only hashed recall queries for search and list telemetry', async () => {
    const searchQuery = 'secret-query-phase19b';
    await memoryManager.saveMemory({
      sessionId: 'phase19b-session',
      content: 'Search telemetry target references secret-query-phase19b in content.',
      type: 'workspace',
      importance: 0.7,
      source: 'manual',
    });

    const searchResults = await memoryManager.searchMemories({
      query: searchQuery,
      projectId: 'phase19b-project',
      limit: 3,
    }, {
      sessionId: 'phase19b-session',
      source: 'search',
    });
    assert.ok(searchResults.length >= 1);

    await memoryManager.listMemories({
      projectId: 'phase19b-project',
      type: 'workspace',
      limit: 5,
    }, {
      sessionId: 'phase19b-session',
      source: 'list',
    });

    const pool = db.getPool();
    const rows = await pool.query(
      `SELECT query_hash, source, row_to_json(memory_recall_events)::text AS raw_row
       FROM memory_recall_events
       WHERE session_id = $1
         AND source IN ('search', 'list')
       ORDER BY id DESC
       LIMIT 5`,
      ['phase19b-session'],
    );

    assert.ok(rows.rows.length >= 2);
    assert.equal(rows.rows.some((row) => row.query_hash === hashRecallQuery(searchQuery)), true);
    assert.equal(
      rows.rows.some((row) => String(row.raw_row).includes(searchQuery)),
      false,
    );
  });

  it('writes recall telemetry for context recall without storing raw queries', async () => {
    contextRecall.setSession('phase19b-session', 'phase19b-project');
    const brief = await contextRecall.refreshSession('phase19b-session', 'phase19b-project');
    assert.ok(brief.semantic.length >= 1);

    const pool = db.getPool();
    const row = await pool.query(
      `SELECT query_hash, source, row_to_json(memory_recall_events)::text AS raw_row
       FROM memory_recall_events
       WHERE session_id = $1 AND source = 'context_recall'
       ORDER BY id DESC LIMIT 1`,
      ['phase19b-session'],
    );

    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0].query_hash, hashRecallQuery('context:phase19b-project'));
    assert.equal(String(row.rows[0].raw_row).includes('context:phase19b-project'), false);
  });

  it('protects old recalled memories while still surfacing old unrecalled ones', async () => {
    const recalled = await memoryManager.saveMemory({
      sessionId: 'phase19b-session',
      content: 'Frequently recalled legacy memory for prune telemetry checks.',
      type: 'workspace',
      importance: 0.2,
      source: 'manual',
    });
    const stale = await memoryManager.saveMemory({
      sessionId: 'phase19b-session',
      content: 'Never recalled legacy memory for prune telemetry checks.',
      type: 'workspace',
      importance: 0.2,
      source: 'manual',
    });
    const pool = db.getPool();

    await pool.query(
      `UPDATE memories
       SET created_at = now() - interval '120 days',
           accessed_at = now() - interval '120 days'
       WHERE id = ANY($1)`,
      [[recalled.id, stale.id]],
    );

    for (let i = 0; i < 3; i++) {
      await memoryManager.searchMemories({
        query: 'Frequently recalled legacy memory',
        projectId: 'phase19b-project',
        limit: 1,
      }, {
        sessionId: 'phase19b-session',
        source: 'search',
      });
    }

    const report = await memoryManager.pruneMemories();
    assert.equal(report.candidates.some((candidate) => candidate.memoryId === recalled.id), false);
    assert.equal(report.candidates.some((candidate) => candidate.memoryId === stale.id), true);
  });
});

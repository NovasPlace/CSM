import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { Database } from '../dist/database.js';
import { MemoryManager } from '../dist/memory-manager.js';
import { EmbeddingGenerator, EMBEDDING_DIMENSIONS } from '../dist/embeddings.js';
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

describe('Phase 19 — fresh schema contract repair', () => {
  const tempDbName = `cross_session_memory_fresh_${Date.now()}`;
  const adminPool = new Pool({ connectionString: buildAdminUrl(BASE_DB_URL) });
  const config: PluginConfig = {
    databaseUrl: buildTempDbUrl(BASE_DB_URL, tempDbName),
    embeddingModel: 'nomic-embed-text',
    embeddingApiUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434',
  } as PluginConfig;

  let db: Database;
  let memoryManager: MemoryManager;

  before(async () => {
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(tempDbName)}`);
    db = new Database(config);
    await db.connect();
    memoryManager = new MemoryManager(db, new EmbeddingGenerator(config));
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

  it('initializes memories.embedding with the runtime vector dimension and saves an embedded memory', async () => {
    const pool = db.getPool();
    const typeResult = await pool.query(
      `SELECT format_type(a.atttypid, a.atttypmod) AS column_type
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = 'memories'
         AND a.attname = 'embedding'
         AND a.attnum > 0
         AND NOT a.attisdropped`,
    );

    assert.equal(typeResult.rows[0].column_type, `vector(${EMBEDDING_DIMENSIONS})`);

    await memoryManager.createSession('fresh-schema-session', 'fresh-project');
    const memory = await memoryManager.saveMemory({
      sessionId: 'fresh-schema-session',
      content: 'Track src/fresh-schema.ts and the repairFreshSchema function.',
      type: 'workspace',
      importance: 0.8,
      source: 'manual',
    });

    assert.ok(memory.id > 0, 'memory should be inserted on a fresh schema');
  });

  it('creates session columns required by runtime lifecycle code', async () => {
    await memoryManager.createSession('session-contract', 'fresh-project');
    await memoryManager.archiveSession('session-contract', 'archived after verification');

    const session = await memoryManager.getSession('session-contract');
    assert.ok(session, 'session must exist');
    assert.equal(session!.summary, 'archived after verification');
    assert.equal(session!.turnCount, 0);
    assert.ok(session!.updatedAt instanceof Date);

    const listed = await memoryManager.getRecentProjectSessions('fresh-project', 5);
    assert.ok(listed.some((item) => item.id === 'session-contract'));

    const pool = db.getPool();
    const row = await pool.query(
      `SELECT workspace_id, summary, turn_count, updated_at, ended_at
       FROM sessions WHERE id = $1`,
      ['session-contract'],
    );
    assert.equal(row.rows[0].workspace_id, null);
    assert.equal(row.rows[0].summary, 'archived after verification');
    assert.equal(row.rows[0].turn_count, 0);
    assert.ok(row.rows[0].updated_at);
    assert.ok(row.rows[0].ended_at);
  });

  it('runs prune dry-run against the real schema without throwing', async () => {
    const report = await memoryManager.pruneMemories();
    assert.ok(Array.isArray(report.candidates));
    assert.equal(report.dryRun, true);
  });

  it('lists memories by extracted_concepts metadata on a fresh schema', async () => {
    await memoryManager.saveMemory({
      sessionId: 'fresh-schema-session',
      content: 'Edited src/fresh-schema.ts to add repairFreshSchema handling.',
      type: 'workspace',
      importance: 0.7,
      source: 'manual',
    });

    const matches = await memoryManager.listMemories({
      projectId: 'fresh-project',
      entityType: 'file',
      entityValue: 'src/fresh-schema.ts',
      limit: 10,
    });

    assert.ok(
      matches.some((memory) => memory.content.includes('src/fresh-schema.ts')),
      'entity filter should match extracted_concepts metadata',
    );
  });
});

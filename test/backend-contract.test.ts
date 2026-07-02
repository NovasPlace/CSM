import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { mkdirSync, rmSync } from 'node:fs';
import { Database } from '../dist/database.js';
import { MemoryManager } from '../dist/memory-manager.js';
import { EmbeddingGenerator } from '../dist/embeddings.js';
import type { PluginConfig } from '../dist/types.js';

// ---------------------------------------------------------------------------
// Phase 3E — Shared backend contract tests
//
// Proves that createSession, saveMemory, and listMemories produce identical
// results on PostgreSQL and SQLite. The PG suite uses a fresh temp database;
// the SQLite suite uses a temp file. Both exercise MemoryManager (not raw pool).
//
// PG requires DATABASE_URL; SQLite runs unconditionally.
// ---------------------------------------------------------------------------

const BASE_DB_URL = process.env.DATABASE_URL
  ?? 'postgresql://postgres:postgres@localhost:5432/cross_session_memory';

const SQLITE_DIR = '.tmp/sqlite-contract';
const SQLITE_PATH = `${SQLITE_DIR}/contract-test.sqlite`;

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

/** Fields that should be identical across both backends after saveMemory. */
interface MemoryContract {
  content: string;
  memoryType: string;
  importance: number;
  emotion: string;
  confidence: number;
  source: string;
  tags: string[];
}

function assertMemoryContract(actual: unknown, expected: MemoryContract): void {
  const m = actual as Record<string, unknown>;
  assert.equal(m.content, expected.content, 'content mismatch');
  assert.equal(m.memoryType, expected.memoryType, 'memoryType mismatch');
  assert.equal(m.importance, expected.importance, 'importance mismatch');
  assert.equal(m.emotion, expected.emotion, 'emotion mismatch');
  assert.equal(m.confidence, expected.confidence, 'confidence mismatch');
  assert.equal(m.source, expected.source, 'source mismatch');
  assert.deepEqual(m.tags, expected.tags, 'tags mismatch');
}

// ---------------------------------------------------------------------------
// PostgreSQL contract suite
// ---------------------------------------------------------------------------

function describePostgres(
  name: string,
  fn: (getMgr: () => MemoryManager) => void,
): void {
  const tempDbName = `csm_contract_${Date.now()}`;
  const adminPool = new Pool({ connectionString: buildAdminUrl(BASE_DB_URL) });
  const config: PluginConfig = {
    databaseUrl: buildTempDbUrl(BASE_DB_URL, tempDbName),
    databaseProvider: 'postgres',
    sqlitePath: SQLITE_PATH,
    embeddingModel: 'nomic-embed-text',
    embeddingApiUrl: 'http://localhost:11434',
  } as PluginConfig;

  let db: Database;
  let mgr: MemoryManager;

  describe(`${name} (PostgreSQL)`, () => {
    before(async () => {
      await adminPool.query(`CREATE DATABASE ${quoteIdentifier(tempDbName)}`);
      db = new Database(config);
      await db.connect();
      mgr = new MemoryManager(db, new EmbeddingGenerator(config));
    });

    after(async () => {
      await db.close();
      await adminPool.query(
        `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [tempDbName],
      );
      await adminPool.query(`DROP DATABASE ${quoteIdentifier(tempDbName)}`);
      await adminPool.end();
    });

    fn(() => mgr);
  });
}

// ---------------------------------------------------------------------------
// SQLite contract suite
// ---------------------------------------------------------------------------

function describeSqlite(
  name: string,
  fn: (getMgr: () => MemoryManager) => void,
): void {
  const config: PluginConfig = {
    databaseUrl: SQLITE_PATH,
    databaseProvider: 'sqlite',
    sqlitePath: SQLITE_PATH,
    embeddingModel: 'nomic-embed-text',
    embeddingApiUrl: 'http://localhost:11434',
  } as PluginConfig;

  let db: Database;
  let mgr: MemoryManager;

  describe(`${name} (SQLite)`, () => {
    before(() => {
      try { mkdirSync(SQLITE_DIR, { recursive: true }); } catch { /* exists */ }
      try { rmSync(SQLITE_PATH); } catch { /* not exists */ }
      try { rmSync(`${SQLITE_PATH}-wal`); } catch { /* not exists */ }
      try { rmSync(`${SQLITE_PATH}-shm`); } catch { /* not exists */ }
    });

    beforeEach(async () => {
      db = new Database(config);
      await db.connect();
      mgr = new MemoryManager(db, new EmbeddingGenerator(config));
    });

    afterEach(async () => {
      await db.close();
    });

    after(() => {
      try { rmSync(SQLITE_PATH); } catch { /* not exists */ }
      try { rmSync(`${SQLITE_PATH}-wal`); } catch { /* not exists */ }
      try { rmSync(`${SQLITE_PATH}-shm`); } catch { /* not exists */ }
      try { rmSync(SQLITE_DIR); } catch { /* not exists */ }
    });

    fn(() => mgr);
  });
}

// ---------------------------------------------------------------------------
// Shared contract assertions — the actual test logic
// ---------------------------------------------------------------------------

const INPUT: MemoryContract = {
  content: 'Contract test memory content',
  memoryType: 'episodic',
  importance: 0.8,
  emotion: 'neutral',
  confidence: 0.95,
  source: 'manual',
  tags: ['test', 'contract', 'phase3e'],
};

function runContractTests(label: string, getMgr: () => MemoryManager): void {
  it('createSession succeeds and returns a session', async () => {
    const mgr = getMgr();
    const session = await mgr.createSession(`${label}-session`, `${label}-project`);
    assert.ok(session, 'session should be truthy');
  });

  it('saveMemory stores and retrieves a memory with correct fields', async () => {
    const mgr = getMgr();
    await mgr.createSession(`${label}-save-session`, `${label}-project`);
    const saved = await mgr.saveMemory({
      sessionId: `${label}-save-session`,
      content: INPUT.content,
      type: INPUT.memoryType,
      importance: INPUT.importance,
      emotion: INPUT.emotion,
      confidence: INPUT.confidence,
      source: INPUT.source,
      tags: INPUT.tags,
    });

    assert.ok(saved, 'saveMemory should return a memory');
    assert.ok((saved as Record<string, unknown>).id, 'saved memory should have an id');
    assertMemoryContract(saved, INPUT);
  });

  it('listMemories returns saved memories with correct field values', async () => {
    const mgr = getMgr();
    await mgr.createSession(`${label}-list-session`, `${label}-project`);
    await mgr.saveMemory({
      sessionId: `${label}-list-session`,
      content: INPUT.content,
      type: INPUT.memoryType,
      importance: INPUT.importance,
      emotion: INPUT.emotion,
      confidence: INPUT.confidence,
      source: INPUT.source,
      tags: INPUT.tags,
    });

    const memories = await mgr.listMemories({
      sessionId: `${label}-list-session`,
    });

    assert.ok(memories.length >= 1, 'should return at least one memory');
    const first = memories[0];
    assertMemoryContract(first, INPUT);
  });

  it('saveMemory with metadata stores and retrieves it', async () => {
    const mgr = getMgr();
    await mgr.createSession(`${label}-meta-session`, `${label}-project`);
    const saved = await mgr.saveMemory({
      sessionId: `${label}-meta-session`,
      content: 'Memory with metadata',
      type: 'procedural',
      importance: 0.5,
      emotion: 'neutral',
      confidence: 1.0,
      source: 'manual',
      tags: ['meta-test'],
      metadata: { customKey: 'customValue', taskId: 'task-42' },
    });

    assert.ok(saved);
    const list = await mgr.listMemories({ sessionId: `${label}-meta-session` });
    assert.ok(list.length >= 1);
    const meta = (list[0] as Record<string, unknown>).metadata as Record<string, unknown> | undefined;
    assert.ok(meta, 'metadata should be present');
    assert.equal(meta.customKey, 'customValue');
    assert.equal(meta.taskId, 'task-42');
  });

  it('getSession retrieves a created session', async () => {
    const mgr = getMgr();
    await mgr.createSession(`${label}-get-session`, `${label}-project`);
    const session = await mgr.getSession(`${label}-get-session`);
    assert.ok(session);
    assert.equal((session as Record<string, unknown>).id, `${label}-get-session`);
  });

  it('touchMemory increments access count', async () => {
    const mgr = getMgr();
    await mgr.createSession(`${label}-touch-session`, `${label}-project`);
    const saved = await mgr.saveMemory({
      sessionId: `${label}-touch-session`,
      content: 'Touch test',
      type: 'episodic',
      importance: 0.5,
      emotion: 'neutral',
      confidence: 1.0,
      source: 'manual',
      tags: [],
    });

    const memId = (saved as Record<string, unknown>).id as number;
    await mgr.touchMemory(memId);
    await mgr.touchMemory(memId);

    const list = await mgr.listMemories({ sessionId: `${label}-touch-session` });
    const touched = list[0] as Record<string, unknown>;
    assert.ok((touched.accessCount as number) >= 2, 'accessCount should be >= 2');
  });
}

// ---------------------------------------------------------------------------
// Run the same contract tests against both backends
// ---------------------------------------------------------------------------

describePostgres('Phase 3E contract', (getMgr) => {
  runContractTests('pg', getMgr);
});

describeSqlite('Phase 3E contract', (getMgr) => {
  runContractTests('sqlite', getMgr);
});

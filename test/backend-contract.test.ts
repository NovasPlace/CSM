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
  fn: (getMgr: () => MemoryManager, getDb: () => Database) => void,
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

    fn(() => mgr, () => db);
  });
}

// ---------------------------------------------------------------------------
// SQLite contract suite
// ---------------------------------------------------------------------------

function describeSqlite(
  name: string,
  fn: (getMgr: () => MemoryManager, getDb: () => Database) => void,
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

    fn(() => mgr, () => db);
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

function runContractTests(label: string, getMgr: () => MemoryManager, getDb: () => Database): void {
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

  it('saveMemory refuses a session/project ownership collision', async () => {
    const mgr = getMgr();
    const sessionId = `${label}-ownership-session`;
    await mgr.createSession(sessionId, `${label}-ownership-project-a`);

    await assert.rejects(
      mgr.saveMemory({
        sessionId,
        projectId: `${label}-ownership-project-b`,
        content: 'Must not cross the project boundary',
        type: 'episodic',
        source: 'manual',
      }),
      /belongs to project .* refusing memory write/,
    );
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
      projectId: `${label}-project`,
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
    const list = await mgr.listMemories({
      sessionId: `${label}-meta-session`,
      projectId: `${label}-project`,
    });
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

    const list = await mgr.listMemories({
      sessionId: `${label}-touch-session`,
      projectId: `${label}-project`,
    });
    const touched = list[0] as Record<string, unknown>;
    assert.ok((touched.accessCount as number) >= 2, 'accessCount should be >= 2');
  });

  it('deleteMemory cannot delete a memory owned by another project', async () => {
    const mgr = getMgr();
    const projectA = `${label}-delete-project-a`;
    const projectB = `${label}-delete-project-b`;
    await mgr.createSession(`${label}-delete-session-a`, projectA);
    await mgr.createSession(`${label}-delete-session-b`, projectB);
    const memoryA = await mgr.saveMemory({
      sessionId: `${label}-delete-session-a`,
      content: 'Project A deletion boundary target',
      type: 'episodic',
      source: 'manual',
    });
    const memoryB = await mgr.saveMemory({
      sessionId: `${label}-delete-session-b`,
      content: 'Project B must survive a project A deletion attempt',
      type: 'episodic',
      source: 'manual',
    });

    assert.equal(await mgr.deleteMemory(memoryB.id, projectA), false);
    assert.equal((await mgr.getMemory(memoryB.id))?.projectId, projectB);
    assert.equal(await mgr.deleteMemory(memoryA.id, projectA), true);
    assert.equal(await mgr.getMemory(memoryA.id), null);
  });

  it('retention cleanup previews first and applies only within one project', async () => {
    const mgr = getMgr();
    const db = getDb();
    const projectA = `${label}-retention-project-a`;
    const projectB = `${label}-retention-project-b`;
    await mgr.createSession(`${label}-retention-session-a`, projectA);
    await mgr.createSession(`${label}-retention-session-b`, projectB);
    const memoryA = await mgr.saveMemory({
      sessionId: `${label}-retention-session-a`, content: 'Expired A memory',
      type: 'episodic', source: 'manual', importance: 0.1,
    });
    const memoryB = await mgr.saveMemory({
      sessionId: `${label}-retention-session-b`, content: 'Expired B memory',
      type: 'episodic', source: 'manual', importance: 0.1,
    });
    await db.getPool().query(
      'UPDATE memories SET created_at = $1 WHERE id IN ($2, $3)',
      [new Date(Date.now() - 400 * 86_400_000).toISOString(), memoryA.id, memoryB.id],
    );
    const ttl = {
      enabled: true,
      defaultDays: 90,
      byType: { episodic: 7 },
      byImportance: [{ min: 0, max: 1, days: 30 }],
      gracePeriodDays: 7,
    };

    const preview = await mgr.cleanupExpiredMemories({ projectId: projectA, ttl });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.eligible, 1);
    assert.equal(preview.deleted, 0);
    assert.ok(await mgr.getMemory(memoryA.id));

    const applied = await mgr.cleanupExpiredMemories({ projectId: projectA, ttl, apply: true });
    assert.equal(applied.dryRun, false);
    assert.equal(applied.deleted, 1);
    assert.equal(await mgr.getMemory(memoryA.id), null);
    assert.equal((await mgr.getMemory(memoryB.id))?.projectId, projectB);
  });
}

// ---------------------------------------------------------------------------
// Search contract assertions — documents expected search behavior
// ---------------------------------------------------------------------------

function runSearchContractTests(label: string, getMgr: () => MemoryManager): void {
  it('searchMemories returns matching content via prefix', async () => {
    const mgr = getMgr();
    await mgr.createSession(`${label}-search-session`, `${label}-search-project`);
    await mgr.saveMemory({
      sessionId: `${label}-search-session`,
      content: 'Phase3F-Alpha unique searchable content',
      type: 'episodic',
      importance: 0.9,
      emotion: 'neutral',
      confidence: 1.0,
      source: 'manual',
      tags: [],
    });

    const results = await mgr.searchMemories({
      query: 'Phase3F-Alpha',
      projectId: `${label}-search-project`,
      limit: 10,
    });

    assert.ok(results.length >= 1, 'should find at least one match');
    const first = results[0].memory as Record<string, unknown>;
    assert.ok(
      (first.content as string).includes('Phase3F-Alpha'),
      'returned memory should contain the search term',
    );
  });

  it('searchMemories returns empty for non-matching query', async () => {
    const mgr = getMgr();
    await mgr.createSession(`${label}-nomatch-session`, `${label}-nomatch-project`);
    await mgr.saveMemory({
      sessionId: `${label}-nomatch-session`,
      content: 'Phase3F-Beta exists in database',
      type: 'episodic',
      importance: 0.5,
      emotion: 'neutral',
      confidence: 1.0,
      source: 'manual',
      tags: [],
    });

    const results = await mgr.searchMemories({
      query: 'ZZZ-NonExistent-Query-12345',
      projectId: `${label}-nomatch-project`,
      limit: 10,
    });

    // SQLite text fallback: returns 0 for non-matching queries.
    // PG vector search: always returns nearest neighbors (even for garbage queries).
    // Both behaviors are acceptable — the contract is: no cross-project leakage.
    if (results.length > 0) {
      for (const r of results) {
        assert.equal(
          (r.memory as Record<string, unknown>).projectId,
          `${label}-nomatch-project`,
          'any results must be scoped to the correct project',
        );
      }
    } else {
      assert.equal(results.length, 0, 'should return zero results for non-matching query');
    }
  });

  it('searchMemories filters by type', async () => {
    const mgr = getMgr();
    await mgr.createSession(`${label}-type-session`, `${label}-type-project`);
    await mgr.saveMemory({
      sessionId: `${label}-type-session`,
      content: 'Phase3F-TypeTest episodic memory',
      type: 'episodic',
      importance: 0.5,
      emotion: 'neutral',
      confidence: 1.0,
      source: 'manual',
      tags: [],
    });
    await mgr.saveMemory({
      sessionId: `${label}-type-session`,
      content: 'Phase3F-TypeTest procedural memory',
      type: 'procedural',
      importance: 0.5,
      emotion: 'neutral',
      confidence: 1.0,
      source: 'manual',
      tags: [],
    });

    const episodic = await mgr.searchMemories({
      query: 'Phase3F-TypeTest',
      projectId: `${label}-type-project`,
      type: 'episodic',
      limit: 10,
    });
    assert.ok(episodic.length >= 1, 'should find episodic memories');
    for (const r of episodic) {
      assert.equal(
        (r.memory as Record<string, unknown>).memoryType,
        'episodic',
        'all results should be episodic type',
      );
    }

    const procedural = await mgr.searchMemories({
      query: 'Phase3F-TypeTest',
      projectId: `${label}-type-project`,
      type: 'procedural',
      limit: 10,
    });
    assert.ok(procedural.length >= 1, 'should find procedural memories');
    for (const r of procedural) {
      assert.equal(
        (r.memory as Record<string, unknown>).memoryType,
        'procedural',
        'all results should be procedural type',
      );
    }
  });

  it('searchMemories filters by tags', async () => {
    const mgr = getMgr();
    await mgr.createSession(`${label}-tag-session`, `${label}-tag-project`);
    await mgr.saveMemory({
      sessionId: `${label}-tag-session`,
      content: 'Phase3F-Tagged tagged memory one',
      type: 'episodic',
      importance: 0.5,
      emotion: 'neutral',
      confidence: 1.0,
      source: 'manual',
      tags: ['alpha-tag', 'shared-tag'],
    });
    await mgr.saveMemory({
      sessionId: `${label}-tag-session`,
      content: 'Phase3F-Tagged tagged memory two',
      type: 'episodic',
      importance: 0.5,
      emotion: 'neutral',
      confidence: 1.0,
      source: 'manual',
      tags: ['beta-tag', 'shared-tag'],
    });

    const alphaResults = await mgr.searchMemories({
      query: 'Phase3F-Tagged',
      projectId: `${label}-tag-project`,
      tags: ['alpha-tag'],
      limit: 10,
    });
    assert.ok(alphaResults.length >= 1, 'should find alpha-tagged memories');
    for (const r of alphaResults) {
      const tags = (r.memory as Record<string, unknown>).tags as string[];
      assert.ok(tags.includes('alpha-tag'), 'result should have alpha-tag');
    }

    const sharedResults = await mgr.searchMemories({
      query: 'Phase3F-Tagged',
      projectId: `${label}-tag-project`,
      tags: ['shared-tag'],
      limit: 10,
    });
    assert.ok(sharedResults.length >= 2, 'should find both memories with shared-tag');
  });

  it('searchMemories does not throw on any backend (degradation safety)', async () => {
    const mgr = getMgr();
    await mgr.createSession(`${label}-safe-session`, `${label}-safe-project`);
    await mgr.saveMemory({
      sessionId: `${label}-safe-session`,
      content: 'Phase3F-Degradation safety check content',
      type: 'episodic',
      importance: 0.7,
      emotion: 'neutral',
      confidence: 1.0,
      source: 'manual',
      tags: ['safety'],
    });

    // This must not throw on SQLite (vector search degrades to text)
    // and must not throw on PG (hybrid search with hash embeddings)
    const results = await mgr.searchMemories({
      query: 'Phase3F-Degradation',
      projectId: `${label}-safe-project`,
      limit: 5,
    });

    // Both backends should return results for an exact prefix match
    assert.ok(results.length >= 1, 'should return results without throwing');
  });

  it('listMemories filters by tags', async () => {
    const mgr = getMgr();
    await mgr.createSession(`${label}-listtag-session`, `${label}-listtag-project`);
    await mgr.saveMemory({
      sessionId: `${label}-listtag-session`,
      content: 'Phase3F-ListTag first memory',
      type: 'episodic',
      importance: 0.5,
      emotion: 'neutral',
      confidence: 1.0,
      source: 'manual',
      tags: ['list-alpha'],
    });
    await mgr.saveMemory({
      sessionId: `${label}-listtag-session`,
      content: 'Phase3F-ListTag second memory',
      type: 'episodic',
      importance: 0.5,
      emotion: 'neutral',
      confidence: 1.0,
      source: 'manual',
      tags: ['list-beta'],
    });

    const filtered = await mgr.listMemories({
      projectId: `${label}-listtag-project`,
      tags: ['list-alpha'],
      limit: 10,
    });
    assert.ok(filtered.length >= 1, 'should find memories with list-alpha tag');
    for (const m of filtered) {
      const tags = (m as Record<string, unknown>).tags as string[];
      assert.ok(tags.includes('list-alpha'), 'result should have list-alpha tag');
    }
  });

  it('searchMemories respects projectId scope', async () => {
    const mgr = getMgr();
    await mgr.createSession(`${label}-scope-a`, `${label}-scope-project-a`);
    await mgr.createSession(`${label}-scope-b`, `${label}-scope-project-b`);
    await mgr.saveMemory({
      sessionId: `${label}-scope-a`,
      content: 'Phase3F-Scope project A content',
      type: 'episodic',
      importance: 0.8,
      emotion: 'neutral',
      confidence: 1.0,
      source: 'manual',
      tags: [],
    });
    await mgr.saveMemory({
      sessionId: `${label}-scope-b`,
      content: 'Phase3F-Scope project B content',
      type: 'episodic',
      importance: 0.8,
      emotion: 'neutral',
      confidence: 1.0,
      source: 'manual',
      tags: [],
    });

    const projectAResults = await mgr.searchMemories({
      query: 'Phase3F-Scope',
      projectId: `${label}-scope-project-a`,
      limit: 10,
    });

    for (const r of projectAResults) {
      assert.equal(
        (r.memory as Record<string, unknown>).projectId,
        `${label}-scope-project-a`,
        'all results should be from project A',
      );
    }

    const projectBResults = await mgr.searchMemories({
      query: 'Phase3F-Scope',
      projectId: `${label}-scope-project-b`,
      limit: 10,
    });

    for (const r of projectBResults) {
      assert.equal(
        (r.memory as Record<string, unknown>).projectId,
        `${label}-scope-project-b`,
        'all results should be from project B',
      );
    }
  });

  it('project mode without a projectId fails closed', async () => {
    const mgr = getMgr();
    await mgr.createSession(`${label}-missing-scope-session`, `${label}-missing-scope-project`);
    await mgr.saveMemory({
      sessionId: `${label}-missing-scope-session`,
      content: 'Phase3F-MissingScope must not become a global result',
      type: 'episodic',
      importance: 0.8,
      emotion: 'neutral',
      confidence: 1.0,
      source: 'manual',
      tags: [],
    });

    const searched = await mgr.searchMemories({
      query: 'Phase3F-MissingScope',
      searchMode: 'project',
      limit: 10,
    });
    const listed = await mgr.listMemories({
      searchMode: 'project',
      limit: 10,
    });
    const defaultListed = await mgr.listMemories({ limit: 10 });
    assert.deepEqual(searched, []);
    assert.deepEqual(listed, []);
    assert.deepEqual(defaultListed, []);
  });

  it('listMemories widens scope only when global or legacy is explicit', async () => {
    const mgr = getMgr();
    const projectId = `${label}-explicit-scope-project`;
    const projectSession = `${label}-explicit-scope-session`;
    await mgr.createSession(projectSession, projectId);
    const projectMemory = await mgr.saveMemory({
      sessionId: projectSession,
      content: 'Phase3F-ExplicitScope named project memory',
      type: 'episodic',
      importance: 0.8,
      emotion: 'neutral',
      confidence: 1.0,
      source: 'manual',
      tags: [],
    });
    const legacyMemory = await mgr.saveMemory({
      content: 'Phase3F-ExplicitScope legacy memory',
      type: 'episodic',
      importance: 0.8,
      emotion: 'neutral',
      confidence: 1.0,
      source: 'manual',
      tags: [],
    });

    const global = await mgr.listMemories({
      projectId,
      searchMode: 'global',
      limit: 100,
    });
    const legacyOnly = await mgr.listMemories({
      searchMode: 'legacy',
      limit: 100,
    });
    const projectPlusLegacy = await mgr.listMemories({
      projectId,
      searchMode: 'legacy',
      limit: 100,
    });

    assert.ok(global.some((memory) => memory.id === projectMemory.id));
    assert.ok(global.some((memory) => memory.id === legacyMemory.id));
    assert.ok(legacyOnly.some((memory) => memory.id === legacyMemory.id));
    assert.ok(legacyOnly.every((memory) => memory.projectId == null));
    assert.ok(projectPlusLegacy.some((memory) => memory.id === projectMemory.id));
    assert.ok(projectPlusLegacy.some((memory) => memory.id === legacyMemory.id));
  });
}

// ---------------------------------------------------------------------------
// Run both CRUD and search contract tests against both backends
// ---------------------------------------------------------------------------

describePostgres('Phase 3E/3F contract', (getMgr, getDb) => {
  runContractTests('pg', getMgr, getDb);
  runSearchContractTests('pg', getMgr);
});

describeSqlite('Phase 3E/3F contract', (getMgr, getDb) => {
  runContractTests('sqlite', getMgr, getDb);
  runSearchContractTests('sqlite', getMgr);
});

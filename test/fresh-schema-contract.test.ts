import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { Database } from '../dist/database.js';
import { buildOnboardingPacket } from '../dist/agent-onboarding.js';
import { CausalThreadHydrator } from '../dist/self-continuity-causal-thread.js';
import { MemoryManager } from '../dist/memory-manager.js';
import { EmbeddingGenerator, EMBEDDING_DIMENSIONS } from '../dist/embeddings.js';
import { StatsWriter } from '../dist/stats-writer.js';
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
    databaseProvider: 'postgres',
    sqlitePath: '.data/csm-memory.db',
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

  it('writes dashboard stats against a fresh schema using metadata turn IDs', async () => {
    const statsDir = `.tmp/fresh-schema-stats-${process.pid}`;
    const statsPath = `${statsDir}/stats.json`;
    mkdirSync(statsDir, { recursive: true });
    try {
      await memoryManager.createSession('fresh-stats-session', 'fresh-project');
      await memoryManager.saveMemory({
        sessionId: 'fresh-stats-session',
        content: 'Saved with a metadata turn ID for fresh stats coverage.',
        type: 'episodic',
        source: 'manual',
        metadata: { turnId: 'fresh-turn-1' },
      });
      await new StatsWriter(db.getPool(), statsPath).write();
      assert.ok(existsSync(statsPath));
      const stats = JSON.parse(readFileSync(statsPath, 'utf8')) as { recentMemories: Array<{ turnId: string | null }> };
      assert.ok(stats.recentMemories.some((memory) => memory.turnId === 'fresh-turn-1'));
    } finally {
      rmSync(statsDir, { recursive: true, force: true });
    }
  });

  it('hydrates an actual graph link through the causal-thread schema', async () => {
    await memoryManager.createSession('fresh-causal-session', 'fresh-project');
    const first = await memoryManager.saveMemory({
      sessionId: 'fresh-causal-session',
      content: 'Investigated src/causal-thread.ts before the repair.',
      type: 'episodic',
      source: 'manual',
    });
    const second = await memoryManager.saveMemory({
      sessionId: 'fresh-causal-session',
      content: 'Fixed src/causal-thread.ts after the investigation.',
      type: 'episodic',
      source: 'manual',
    });
    const result = await new CausalThreadHydrator(db.getPool()).hydrateCausalThread({
      memoryId: second.id,
      sessionId: 'fresh-causal-session',
    });
    assert.ok(result.thread.some((node) => node.memoryId === first.id));
  });

  it('includes active memories and promoted beliefs in a fresh-schema onboarding packet', async () => {
    const projectId = 'fresh-onboarding-project';
    await memoryManager.createSession('fresh-onboarding-session', projectId);
    await memoryManager.saveMemory({
      sessionId: 'fresh-onboarding-session',
      content: 'Fresh onboarding memory must be visible.',
      type: 'lesson',
      importance: 0.9,
      source: 'manual',
    });
    await db.getPool().query(
      `INSERT INTO belief_knowledge_store
       (belief_kind, subject, claim, stance, confidence, uncertainty, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['preference', 'verification', 'run real fresh-schema checks', 'supports', 0.9, 0.1, 'promoted'],
    );
    const packet = await buildOnboardingPacket({
      projectId,
      sessionId: 'fresh-onboarding-session',
      workspacePath: process.cwd(),
      pool: db.getPool(),
      config: {} as PluginConfig,
    });
    const memories = packet.sections.find((section) => section.section === 'relevant-memories');
    const beliefs = packet.sections.find((section) => section.section === 'promoted-beliefs');
    assert.ok(memories?.content.includes('Fresh onboarding memory'));
    assert.ok(beliefs?.content.includes('run real fresh-schema checks'));
  });
});

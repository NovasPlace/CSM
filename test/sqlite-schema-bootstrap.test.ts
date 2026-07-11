import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { buildOnboardingPacket } from '../dist/agent-onboarding.js';
import { Database } from '../dist/database.js';
import type { PluginConfig } from '../dist/types.js';

describe('Phase 3C — SQLite schema bootstrap', () => {
  const tmpDir = '.tmp/sqlite-bootstrap';
  const dbPath = `${tmpDir}/csm-test.sqlite`;

  beforeEach(() => {
    try { mkdirSync(tmpDir, { recursive: true }); } catch { /* exists */ }
    try { rmSync(dbPath); } catch { /* not exists */ }
    try { rmSync(`${dbPath}-wal`); } catch { /* not exists */ }
    try { rmSync(`${dbPath}-shm`); } catch { /* not exists */ }
  });

  afterEach(() => {
    try { rmSync(dbPath); } catch { /* not exists */ }
    try { rmSync(`${dbPath}-wal`); } catch { /* not exists */ }
    try { rmSync(`${dbPath}-shm`); } catch { /* not exists */ }
    try { rmSync(tmpDir); } catch { /* not exists */ }
  });

  it('bootstraps minimal SQLite schema with raw CRUD', async () => {
    const config: PluginConfig = {
      databaseUrl: dbPath,
      databaseProvider: 'sqlite',
      sqlitePath: dbPath,
      embeddingModel: 'nomic-embed-text',
      embeddingApiUrl: 'http://localhost:11434',
    };

    const db = new Database(config);
    await db.connect();

    const pool = db.getPool();

    await pool.query("INSERT INTO sessions (id, title) VALUES ($1, $2)", ['phase3c-test', 'Test Session']);

    await pool.query(
      `INSERT INTO memories (session_id, memory_type, content, importance, emotion, confidence, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['phase3c-test', 'episodic', 'Test memory for Phase 3C', 0.5, 'neutral', 1.0, 'manual']
    );

    const result = await pool.query(
      'SELECT id, content, memory_type, importance FROM memories WHERE session_id = $1',
      ['phase3c-test']
    );
    assert.equal(result.rows.length, 1);
    assert.equal((result.rows[0] as { content: string }).content, 'Test memory for Phase 3C');
    assert.equal((result.rows[0] as { memory_type: string }).memory_type, 'episodic');
    assert.equal((result.rows[0] as { importance: number }).importance, 0.5);

    await db.close();
  });

  it('schema tables exist with correct types', async () => {
    const config: PluginConfig = {
      databaseUrl: dbPath,
      databaseProvider: 'sqlite',
      sqlitePath: dbPath,
      embeddingModel: 'nomic-embed-text',
      embeddingApiUrl: 'http://localhost:11434',
    };

    const db = new Database(config);
    await db.connect();

    const pool = db.getPool();

    // Check sessions table
    const sessionResult = await pool.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'");
    assert.ok(sessionResult.rows.length > 0);
    assert.ok(sessionResult.rows[0].sql.includes('PRIMARY KEY'));
    assert.ok(sessionResult.rows[0].sql.includes('created_at'));

    const projectResult = await pool.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='project_scopes'");
    assert.ok(projectResult.rows.length > 0);
    assert.ok(projectResult.rows[0].sql.includes('last_active_at'));

    // Check memories table
    const memoryResult = await pool.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'");
    assert.ok(memoryResult.rows.length > 0);
    assert.ok(memoryResult.rows[0].sql.includes('PRIMARY KEY'));
    assert.ok(memoryResult.rows[0].sql.includes('memory_type'));
    assert.ok(memoryResult.rows[0].sql.includes('content'));

    // Check memory_chunks table
    const chunkResult = await pool.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_chunks'");
    assert.ok(chunkResult.rows.length > 0);
    assert.ok(chunkResult.rows[0].sql.includes('memory_id'));
    assert.ok(chunkResult.rows[0].sql.includes('UNIQUE'));

    // Check memory_merges table
    const mergeResult = await pool.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_merges'");
    assert.ok(mergeResult.rows.length > 0);
    assert.ok(mergeResult.rows[0].sql.includes('canonical_id'));

    const graphResult = await pool.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_links'");
    assert.ok(graphResult.rows.length > 0);
    assert.ok(graphResult.rows[0].sql.includes('source_id'));

    // Check memory_quality_scores table
    const qualityResult = await pool.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_quality_scores'");
    assert.ok(qualityResult.rows.length > 0);
    assert.ok(qualityResult.rows[0].sql.includes('memory_id'));
    assert.ok(qualityResult.rows[0].sql.includes('UNIQUE'));

    await db.close();
  });

  it('handles foreign key constraints', async () => {
    const config: PluginConfig = {
      databaseUrl: dbPath,
      databaseProvider: 'sqlite',
      sqlitePath: dbPath,
      embeddingModel: 'nomic-embed-text',
      embeddingApiUrl: 'http://localhost:11434',
    };

    const db = new Database(config);
    await db.connect();

    const pool = db.getPool();

    // Create a session
    await pool.query("INSERT INTO sessions (id, title) VALUES ('test-session', 'Test')");

    // Insert a memory that references the session
    await pool.query(
      "INSERT INTO memories (session_id, memory_type, content) VALUES ('test-session', 'episodic', 'test')"
    );

    // Verify the join works
    const result = await pool.query(`
      SELECT m.id, m.content, s.title
      FROM memories m
      JOIN sessions s ON m.session_id = s.id
      WHERE s.id = 'test-session'
    `);

    assert.ok(result.rows.length > 0);
    assert.equal((result.rows[0] as { content: string }).content, 'test');

    await db.close();
  });

  it('counts SQLite experience packets from the previous 24 hours in onboarding', async () => {
    const config: PluginConfig = {
      databaseUrl: dbPath,
      databaseProvider: 'sqlite',
      sqlitePath: dbPath,
      embeddingModel: 'nomic-embed-text',
      embeddingApiUrl: 'http://localhost:11434',
    };
    const db = new Database(config);
    await db.connect();
    const pool = db.getPool();
    const sessionId = 'sqlite-advisory-session';
    const projectId = 'sqlite-advisory-project';

    await pool.query('INSERT INTO sessions (id, title) VALUES ($1, $2)', [sessionId, 'Advisory test']);
    await pool.query(
      `INSERT INTO experience_packets (session_id, project_id, entry_type, created_at)
       VALUES ($1, $2, $3, datetime('now', '-23 hours'))`,
      [sessionId, projectId, 'tool_execution'],
    );

    const packet = await buildOnboardingPacket({
      projectId,
      sessionId,
      workspacePath: process.cwd(),
      pool,
      config,
    });
    const advisories = packet.sections.find((section) => section.section === 'advisories');

    assert.ok(advisories?.content.includes('Experience packets (24h): 1'));
    await db.close();
  });

  it('records and replays the SQLite migration manifest once', async () => {
    const config = {
      databaseUrl: dbPath,
      databaseProvider: 'sqlite',
      sqlitePath: dbPath,
      embeddingModel: 'nomic-embed-text',
      embeddingApiUrl: 'http://localhost:11434',
    } as PluginConfig;
    const first = new Database(config);
    await first.connect();
    await first.close();

    const second = new Database(config);
    await second.connect();
    const result = await second.getPool().query(
      `SELECT migration_id, checksum, provider
       FROM csm_schema_migrations ORDER BY migration_id`,
    );
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].migration_id, '20260709-001-sqlite-baseline');
    assert.equal(result.rows[1].migration_id, '20260711-002-sqlite-work-journal');
    for (const row of result.rows) {
      assert.match(row.checksum, /^[a-f0-9]{64}$/);
      assert.equal(row.provider, 'sqlite');
    }
    await second.close();
  });

  it('upgrades a baseline-only SQLite database with the work journal', async () => {
    const config = {
      databaseUrl: dbPath,
      databaseProvider: 'sqlite',
      sqlitePath: dbPath,
      embeddingModel: 'nomic-embed-text',
      embeddingApiUrl: 'http://localhost:11434',
    } as PluginConfig;
    const legacy = new Database(config);
    await legacy.connect();
    await legacy.getPool().query('DROP TABLE agent_work_journal');
    await legacy.getPool().query(
      'DELETE FROM csm_schema_migrations WHERE migration_id = $1',
      ['20260711-002-sqlite-work-journal'],
    );
    await legacy.close();

    const upgraded = new Database(config);
    await upgraded.connect();
    const table = await upgraded.getPool().query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_work_journal'",
    );
    assert.equal(table.rows.length, 1);
    await upgraded.close();
  });
});

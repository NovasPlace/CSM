import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSqlitePool } from '../src/db/sqlite-pool.js';
import { runCapabilityProvenanceMigration } from '../src/schema/capability-provenance-migration.js';
import type { DatabasePool } from '../src/types.js';

const MEMORIES_DDL = `
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_type TEXT NOT NULL,
    content TEXT NOT NULL,
    importance REAL DEFAULT 0.5,
    confidence REAL DEFAULT 1.0,
    source TEXT DEFAULT '',
    tags TEXT DEFAULT '[]',
    metadata TEXT DEFAULT '{}',
    session_id TEXT,
    project_id TEXT,
    embedding BLOB,
    superseded_by INTEGER,
    superseded_at TEXT,
    archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`;

async function insertOldShapeMemory(pool: DatabasePool, overrides: Record<string, unknown> = {}): Promise<{ id: number; content: string; metadata: string }> {
  const dedupKey = overrides.dedup_key ?? 'cap:edit:ok';
  const meta = JSON.stringify({
    promotion_source: 'belief_promotion_engine',
    candidate_type: 'candidate_capability',
    dedup_key: dedupKey,
    candidate_id: overrides.candidate_id ?? 1,
    source_packet_ids: [1, 2],
    evidence_sessions: 2,
    confidence: 0.8,
    reinforcement_count: 7,
    event_count: 7,
    promoted_at: '2026-07-11T10:00:00Z',
    source_kind: 'belief_promotion',
    evidence_strength: 'derived_pattern',
    source_agent_id: 'csmt',
  });
  const content = overrides.content ?? `[Promoted from candidate ${overrides.candidate_id ?? 1}] edit used successfully`;

  await pool.query(
    `INSERT INTO memories (memory_type, content, importance, confidence, source, tags, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    ['workspace', content, 0.76, 0.8, 'auto',
     JSON.stringify(['candidate_capability', 'auto-promoted']),
     meta, new Date().toISOString(), new Date().toISOString()],
  );

  const result = await pool.query(
    `SELECT id, content, metadata FROM memories WHERE json_extract(metadata, '$.dedup_key') = $1 ORDER BY id DESC LIMIT 1`,
    [dedupKey],
  );
  return result.rows[0] as { id: number; content: string; metadata: string };
}

describe('Capability provenance migration — SQLite', () => {
  let pool: DatabasePool;

  before(async () => {
    pool = await createSqlitePool(':memory:');
    await pool.query(MEMORIES_DDL);
  });

  after(async () => { await pool.end(); });

  beforeEach(async () => {
    await pool.query('DELETE FROM memories');
  });

  it('rewrites old-shape capability promotion records to provenance format', async () => {
    const oldRow = await insertOldShapeMemory(pool, { dedup_key: 'cap:edit:ok', candidate_id: 100 });
    assert.ok(oldRow.content.startsWith('[Promoted from candidate'), 'precondition: record should be old shape');

    const result = await runCapabilityProvenanceMigration(pool);
    assert.equal(result.found, 1, 'should find 1 historical record');
    assert.equal(result.migrated, 1, 'should migrate 1 record');
    assert.equal(result.alreadyMigrated, 0, 'none should be already migrated');
    assert.equal(result.skipped, 0, 'none should be skipped');

    const newRowResult = await pool.query('SELECT content, metadata FROM memories WHERE id = $1', [oldRow.id]);
    const newRow = newRowResult.rows[0] as { content: string; metadata: string };
    assert.ok(newRow.content.startsWith('[Capability provenance]'), 'content should start with [Capability provenance]');
    assert.ok(newRow.content.includes('tool:edit:reliability'), 'content should reference canonical key');
    assert.ok(newRow.content.includes('crossed promotion threshold'), 'content should mention threshold crossing');
    assert.ok(newRow.content.includes('[Snapshot'), 'content should identify as snapshot');

    const meta = JSON.parse(newRow.metadata);
    assert.equal(meta.record_type, 'capability_provenance', 'metadata should have record_type');
    assert.equal(meta.canonical_key, 'tool:edit:reliability', 'metadata should have canonical_key');
    assert.equal(meta.dedup_key, 'cap:edit:ok', 'metadata should preserve dedup_key');
    assert.equal(meta.candidate_id, 100, 'metadata should preserve candidate_id');
  });

  it('second run is idempotent (alreadyMigrated, not migrated)', async () => {
    await insertOldShapeMemory(pool, { dedup_key: 'cap:write:ok' });

    const result1 = await runCapabilityProvenanceMigration(pool);
    assert.equal(result1.found, 1);
    assert.equal(result1.migrated, 1);
    assert.equal(result1.alreadyMigrated, 0);

    const result2 = await runCapabilityProvenanceMigration(pool);
    assert.equal(result2.found, 1, 'should still find the record');
    assert.equal(result2.migrated, 0, 'should not migrate again');
    assert.equal(result2.alreadyMigrated, 1, 'should report alreadyMigrated=1');
    assert.equal(result2.skipped, 0);
  });

  it('skips malformed records with unparseable dedup_key', async () => {
    const meta = JSON.stringify({
      promotion_source: 'belief_promotion_engine',
      candidate_type: 'candidate_capability',
      dedup_key: 'not-a-cap-key',
      candidate_id: 999,
    });
    await pool.query(
      `INSERT INTO memories (memory_type, content, importance, confidence, source, tags, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      ['workspace', 'malformed record', 0.5, 0.7, 'auto', '[]', meta,
       new Date().toISOString(), new Date().toISOString()],
    );

    const result = await runCapabilityProvenanceMigration(pool);
    assert.equal(result.found, 1);
    assert.equal(result.migrated, 0, 'should not migrate malformed record');
    assert.equal(result.skipped, 1, 'should skip malformed record');
    assert.equal(result.skippedDetails.length, 1, 'should have skip detail');
    assert.ok(result.skippedDetails[0].includes('not-a-cap-key'), 'detail should mention the bad dedup_key');
  });

  it('multiple records migrated in one run', async () => {
    await insertOldShapeMemory(pool, { dedup_key: 'cap:edit:ok' });
    await insertOldShapeMemory(pool, { dedup_key: 'cap:write:ok' });
    await insertOldShapeMemory(pool, { dedup_key: 'cap:read:ok' });
    await insertOldShapeMemory(pool, { dedup_key: 'cap:bash:ok' });
    await insertOldShapeMemory(pool, { dedup_key: 'cap:grep:ok' });

    const result = await runCapabilityProvenanceMigration(pool);
    assert.equal(result.found, 5, 'should find all 5 records');
    assert.equal(result.migrated, 5, 'should migrate all 5');
    assert.equal(result.alreadyMigrated, 0);
    assert.equal(result.skipped, 0);

    const result2 = await runCapabilityProvenanceMigration(pool);
    assert.equal(result2.found, 5);
    assert.equal(result2.migrated, 0);
    assert.equal(result2.alreadyMigrated, 5, 'all 5 already migrated on second run');
  });

  it('non-capability memories are not touched', async () => {
    const meta = JSON.stringify({
      promotion_source: 'belief_promotion_engine',
      candidate_type: 'candidate_preference',
      dedup_key: 'pref:workflow:tdd',
    });
    await pool.query(
      `INSERT INTO memories (memory_type, content, importance, confidence, source, tags, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      ['preference', 'regular preference memory', 0.5, 0.7, 'auto', '[]', meta,
       new Date().toISOString(), new Date().toISOString()],
    );

    const result = await runCapabilityProvenanceMigration(pool);
    assert.equal(result.found, 0, 'non-capability memories should not be found');
    assert.equal(result.migrated, 0);
  });
});

// ============================================================================
// PostgreSQL integration: migration + structural dedup
// (skipped unless CSM_DATABASE_URL is set and reachable)
// ============================================================================

const PG_URL = process.env.CSM_DATABASE_URL ?? '';

describe('Capability provenance migration — PostgreSQL', { skip: !PG_URL }, () => {
  let pgPool: any = null;

  before(async () => {
    try {
      const pg = await import('pg');
      pgPool = new pg.default.Pool({ connectionString: PG_URL, connectionTimeoutMillis: 2000 });
      await pgPool.query('SELECT 1');
    } catch (err) {
      console.error('PostgreSQL unavailable — PG integration tests blocked:', err instanceof Error ? err.message : err);
      pgPool = null;
    }
  });

  after(async () => { if (pgPool) await pgPool.end(); });

  beforeEach(async () => {
    if (!pgPool) return;
    await pgPool.query(
      "DELETE FROM memories WHERE metadata->>'dedup_key' IN ('cap:provenance-migration-pg-edit:ok', 'cap:provenance-migration-pg-grep:ok')",
    ).catch(() => {});
  });

  it('migrates old-shape records and is idempotent on PG', async () => {
    if (!pgPool) { console.log('PG unavailable — test blocked'); return; }

    const meta = JSON.stringify({
      promotion_source: 'belief_promotion_engine',
      candidate_type: 'candidate_capability',
      dedup_key: 'cap:provenance-migration-pg-edit:ok',
      candidate_id: 100,
      source_packet_ids: [1, 2],
      evidence_sessions: 2,
      confidence: 0.8,
      reinforcement_count: 7,
      event_count: 7,
      promoted_at: '2026-07-11T10:00:00Z',
    });
    await pgPool.query(
      `INSERT INTO memories (memory_type, content, importance, confidence, source, tags, metadata)
       VALUES ('workspace', '[Promoted from candidate 100] edit used successfully', 0.76, 0.8, 'auto', $2, $1)`,
      [meta, ['candidate_capability', 'auto-promoted']],
    );

    const result1 = await runCapabilityProvenanceMigration(pgPool);
    assert.equal(result1.found, 1);
    assert.equal(result1.migrated, 1);
    assert.equal(result1.alreadyMigrated, 0);

    const row = await pgPool.query(
      "SELECT content, metadata FROM memories WHERE metadata->>'dedup_key' = 'cap:provenance-migration-pg-edit:ok' AND metadata->>'candidate_type' = 'candidate_capability'",
    );
    assert.equal(row.rows.length, 1);
    assert.ok(row.rows[0].content.startsWith('[Capability provenance]'));
    const rowMeta = typeof row.rows[0].metadata === 'string' ? JSON.parse(row.rows[0].metadata) : row.rows[0].metadata;
    assert.equal(rowMeta.record_type, 'capability_provenance');

    const result2 = await runCapabilityProvenanceMigration(pgPool);
    assert.equal(result2.found, 1);
    assert.equal(result2.migrated, 0);
    assert.equal(result2.alreadyMigrated, 1);

    await pgPool.query("DELETE FROM memories WHERE metadata->>'dedup_key' = 'cap:provenance-migration-pg-edit:ok' AND metadata->>'candidate_type' = 'candidate_capability'").catch(() => {});
  });

  it('structural dedup prevents duplicate promotion on PG', async () => {
    if (!pgPool) { console.log('PG unavailable — test blocked'); return; }

    const meta = JSON.stringify({
      promotion_source: 'belief_promotion_engine',
      candidate_type: 'candidate_capability',
      dedup_key: 'cap:provenance-migration-pg-grep:ok',
      record_type: 'capability_provenance',
      canonical_key: 'tool:grep:reliability',
    });
    await pgPool.query(
      `INSERT INTO memories (memory_type, content, importance, confidence, source, tags, metadata)
       VALUES ('workspace', '[Capability provenance] existing record', 0.5, 0.7, 'auto', $2, $1)`,
      [meta, []],
    );

    const dupResult = await pgPool.query(
      `SELECT id, content FROM memories
       WHERE memory_type = 'workspace'
         AND metadata->>'dedup_key' = 'cap:provenance-migration-pg-grep:ok'
       LIMIT 1`,
    );
    assert.equal(dupResult.rows.length, 1, 'structural dedup should find existing record by dedup_key');

    await pgPool.query("DELETE FROM memories WHERE metadata->>'dedup_key' = 'cap:provenance-migration-pg-grep:ok' AND metadata->>'candidate_type' = 'candidate_capability'").catch(() => {});
  });
});

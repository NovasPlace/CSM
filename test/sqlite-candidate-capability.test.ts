import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { createSqlitePool } from '../dist/db/sqlite-pool.js';
import { initializeSqliteLivingState } from '../dist/schema/sqlite/living-state.js';

const tempDir = '.tmp/sqlite-candidate-capability';
const dbPath = `${tempDir}/candidate.sqlite`;

function cleanup(): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { rmSync(path); } catch { /* absent */ }
  }
}

async function createMinimalMemoriesTable(pool: Awaited<ReturnType<typeof createSqlitePool>>): Promise<void> {
  await pool.query('CREATE TABLE memories (id INTEGER PRIMARY KEY)');
}

async function insertCapabilityCandidate(pool: Awaited<ReturnType<typeof createSqlitePool>>, dedupKey: string): Promise<void> {
  await pool.query(
    `INSERT INTO memory_candidate_queue
       (candidate_type, memory_id, dedup_key, reason, confidence, source_signals, status)
     VALUES ('candidate_capability', NULL, $1, 'capability evidence', 0.8, '{}', 'pending')`,
    [dedupKey],
  );
}

describe('SQLite candidate_capability schema parity', () => {
  beforeEach(() => {
    mkdirSync(tempDir, { recursive: true });
    cleanup();
  });

  afterEach(() => {
    cleanup();
    try { rmSync(tempDir); } catch { /* absent */ }
  });

  it('accepts candidate_capability in a fresh SQLite living-state schema', async () => {
    const pool = await createSqlitePool(dbPath);
    try {
      await createMinimalMemoriesTable(pool);
      await initializeSqliteLivingState(pool);
      await insertCapabilityCandidate(pool, 'cap:fresh:ok');

      const result = await pool.query(
        `SELECT candidate_type, dedup_key FROM memory_candidate_queue WHERE dedup_key = $1`,
        ['cap:fresh:ok'],
      );
      assert.deepEqual(result.rows, [
        { candidate_type: 'candidate_capability', dedup_key: 'cap:fresh:ok' },
      ]);
    } finally {
      await pool.end();
    }
  });

  it('rebuilds the legacy CHECK constraint without losing existing candidate rows', async () => {
    const pool = await createSqlitePool(dbPath);
    try {
      await createMinimalMemoriesTable(pool);
      await pool.query(`
        CREATE TABLE memory_candidate_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          candidate_type TEXT NOT NULL CHECK (candidate_type IN (
            'prune', 'promote_to_lesson', 'merge', 'stale_preference', 'refresh_summary',
            'candidate_belief', 'candidate_preference', 'candidate_worldview',
            'candidate_drift_warning', 'candidate_opinion'
          )),
          memory_id INTEGER REFERENCES memories(id) ON DELETE CASCADE,
          reason TEXT NOT NULL,
          confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
          source_signals TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
            'pending', 'reviewed', 'dismissed', 'applied'
          )),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      await pool.query(
        `INSERT INTO memory_candidate_queue
           (candidate_type, memory_id, reason, confidence, source_signals, status)
         VALUES ('candidate_opinion', NULL, 'legacy row', 0.6, '{}', 'reviewed')`,
      );

      await initializeSqliteLivingState(pool);

      const preserved = await pool.query(
        `SELECT id, candidate_type, reason, status FROM memory_candidate_queue ORDER BY id`,
      );
      assert.deepEqual(preserved.rows, [
        { id: 1, candidate_type: 'candidate_opinion', reason: 'legacy row', status: 'reviewed' },
      ]);

      await insertCapabilityCandidate(pool, 'cap:migrated:ok');
      const capability = await pool.query(
        `SELECT candidate_type FROM memory_candidate_queue WHERE dedup_key = $1`,
        ['cap:migrated:ok'],
      );
      assert.deepEqual(capability.rows, [{ candidate_type: 'candidate_capability' }]);

      const schema = await pool.query(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_candidate_queue'`,
      );
      assert.match(String((schema.rows[0] as { sql?: unknown }).sql ?? ''), /candidate_capability/);

      const indexes = await pool.query(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND tbl_name = 'memory_candidate_queue' AND name LIKE 'idx_memory_candidate_queue_%'`,
      );
      assert.equal(indexes.rows.length, 4);
    } finally {
      await pool.end();
    }
  });
});

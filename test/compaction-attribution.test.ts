import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { Database } from '../dist/database.js';
import { auditCompactionTelemetry } from '../dist/compaction-telemetry-audit.js';
import { writeCompactionMetric } from '../dist/compaction-metric-writer.js';
import { migrateCompactionAttribution } from '../dist/schema/compaction-attribution-migration.js';
import type { PluginConfig } from '../dist/types.js';

describe('compaction attribution and net accounting', () => {
  const tmpDir = '.tmp/compaction-attribution';
  const dbPath = `${tmpDir}/csm-test.sqlite`;

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    removeDb();
  });

  afterEach(() => {
    removeDb();
    try { rmSync(tmpDir, { recursive: true }); } catch { /* absent */ }
  });

  it('repairs a legacy table and backfills project attribution from sessions', async () => {
    const db = new Database(config());
    await db.connect();
    const pool = db.getPool();
    await pool.query(
      `INSERT INTO sessions (id, project_id, directory) VALUES ($1, $2, $2)`,
      ['legacy-session', 'C:/projects/alpha'],
    );
    await pool.query('DROP TABLE compaction_metrics');
    await pool.query(`
      CREATE TABLE compaction_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        total_tool_parts INTEGER NOT NULL DEFAULT 0,
        compacted_parts INTEGER NOT NULL DEFAULT 0,
        skipped_parts INTEGER NOT NULL DEFAULT 0,
        before_chars INTEGER NOT NULL DEFAULT 0,
        after_chars INTEGER NOT NULL DEFAULT 0,
        before_tokens INTEGER NOT NULL DEFAULT 0,
        after_tokens INTEGER NOT NULL DEFAULT 0,
        tokens_saved INTEGER NOT NULL DEFAULT 0,
        saved_percent INTEGER NOT NULL DEFAULT 0,
        semantic_signal_count_preserved INTEGER NOT NULL DEFAULT 0,
        context_brief_chars INTEGER NOT NULL DEFAULT 0,
        discard_marker_present INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'compressed',
        created_at TEXT NOT NULL
      )
    `);
    await pool.query(
      `INSERT INTO compaction_metrics (
        session_id, before_tokens, after_tokens, tokens_saved, created_at
      ) VALUES ($1, 1000, 700, 300, $2)`,
      ['legacy-session', '2026-07-21T12:00:00.000Z'],
    );

    await migrateCompactionAttribution(pool);
    await migrateCompactionAttribution(pool);

    const result = await pool.query(
      `SELECT project_id, client_kind, runtime_kind, eligible_parts, persisted_parts
       FROM compaction_metrics WHERE session_id = $1`,
      ['legacy-session'],
    );
    assert.deepEqual(result.rows[0], {
      project_id: 'C:/projects/alpha',
      client_kind: 'unknown',
      runtime_kind: 'unknown',
      eligible_parts: 0,
      persisted_parts: 0,
    });
    await db.close();
  });

  it('reports database-wide coverage, project/runtime attribution, failures, and net savings', async () => {
    const db = new Database(config());
    await db.connect();
    const pool = db.getPool();
    await pool.query(
      `INSERT INTO sessions (id, project_id, directory) VALUES ($1, $2, $2)`,
      ['measured-session', 'C:/projects/alpha'],
    );
    await pool.query(
      `INSERT INTO sessions (id, project_id, directory) VALUES ($1, $2, $2)`,
      ['unmeasured-session', 'C:/projects/beta'],
    );
    await writeCompactionMetric(pool, {
      sessionId: 'measured-session',
      projectId: 'C:/projects/alpha',
      clientKind: 'opencode',
      runtimeKind: 'plugin',
      totalToolParts: 10,
      compactedParts: 5,
      skippedParts: 0,
      eligibleParts: 5,
      persistedParts: 5,
      beforeChars: 4000,
      afterChars: 1200,
      beforeTokens: 1000,
      afterTokens: 300,
      tokensSaved: 700,
      savedPercent: 70,
      semanticSignalCountPreserved: 2,
      contextBriefChars: 0,
      discardMarkerPresent: 0,
      status: 'compressed',
      createdAt: '2026-07-21T12:00:00.000Z',
    });
    await pool.query(`
      INSERT INTO context_injection_events (
        idempotency_key, project_id, session_id, injection_kind,
        environment, status, char_count, estimated_tokens,
        trim_level, builder_version, config_hash
      ) VALUES ($1, $2, $3, 'reentry', 'production', 'injected', 400, 100, 'none', 'test', 'test')
    `, ['net-accounting', 'C:/projects/alpha', 'measured-session']);

    const availability = await auditCompactionTelemetry(pool);
    assert.equal(availability.available, true);
    if (!availability.available) throw new Error(availability.reason);
    assert.equal(availability.result.sessionCoverage.totalSessions, 2);
    assert.equal(availability.result.sessionCoverage.measuredSessions, 1);
    assert.equal(availability.result.sessionCoverage.measuredPercent, 50);
    assert.equal(availability.result.injectionOverheadTokens, 100);
    assert.equal(availability.result.databaseInjectionOverheadTokens, 100);
    assert.equal(availability.result.unmatchedInjectionOverheadTokens, 0);
    assert.equal(availability.result.netTokensSaved, 600);
    assert.equal(availability.result.netReductionPercent, 60);
    assert.equal(availability.result.unattributedRows, 0);
    assert.deepEqual(availability.result.projectBreakdown[0], {
      projectId: 'C:/projects/alpha',
      clientKind: 'opencode',
      runtimeKind: 'plugin',
      compactionCount: 1,
      distinctSessions: 1,
      tokensSaved: 700,
      beforeTokens: 1000,
      afterTokens: 300,
    });
    await db.close();
  });

  function config(): PluginConfig {
    return {
      databaseUrl: dbPath,
      databaseProvider: 'sqlite',
      sqlitePath: dbPath,
      embeddingModel: 'nomic-embed-text',
      embeddingApiUrl: 'http://localhost:11434',
    };
  }

  function removeDb(): void {
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(`${dbPath}${suffix}`); } catch { /* absent */ }
    }
  }
});

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { Database } from '../dist/database.js';
import { writeCompactionMetric } from '../dist/compaction-metric-writer.js';
import type { PluginConfig } from '../dist/types.js';
import type { CompactionMetricInput } from '../dist/compaction-metric-writer.js';

describe('Phase 10C2 — Compaction metric writer (SQLite)', () => {
  const tmpDir = '.tmp/compaction-writer-sqlite';
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
    try { rmSync(tmpDir, { recursive: true }); } catch { /* not exists */ }
  });

  function makeConfig(): PluginConfig {
    return {
      databaseUrl: dbPath,
      databaseProvider: 'sqlite',
      sqlitePath: dbPath,
      embeddingModel: 'nomic-embed-text',
      embeddingApiUrl: 'http://localhost:11434',
    };
  }

  function makeRow(overrides: Partial<CompactionMetricInput> = {}): CompactionMetricInput {
    return {
      sessionId: 'test-session',
      totalToolParts: 10,
      compactedParts: 5,
      skippedParts: 2,
      beforeChars: 5000,
      afterChars: 2500,
      beforeTokens: 1500,
      afterTokens: 800,
      tokensSaved: 700,
      savedPercent: 46,
      semanticSignalCountPreserved: 12,
      contextBriefChars: 0,
      discardMarkerPresent: 0,
      status: 'compressed',
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('writes a compressed row and reads it back', async () => {
    const db = new Database(makeConfig());
    await db.connect();
    const pool = db.getPool();

    const row = makeRow({ status: 'compressed' });
    await writeCompactionMetric(pool, row);

    const result = await pool.query('SELECT * FROM compaction_metrics WHERE session_id = $1', [row.sessionId]);
    assert.equal(result.rows.length, 1);
    const stored = result.rows[0] as Record<string, unknown>;
    assert.equal(stored.session_id, 'test-session');
    assert.equal(stored.total_tool_parts, 10);
    assert.equal(stored.compacted_parts, 5);
    assert.equal(stored.skipped_parts, 2);
    assert.equal(stored.before_chars, 5000);
    assert.equal(stored.after_chars, 2500);
    assert.equal(stored.before_tokens, 1500);
    assert.equal(stored.after_tokens, 800);
    assert.equal(stored.tokens_saved, 700);
    assert.equal(stored.saved_percent, 46);
    assert.equal(stored.semantic_signal_count_preserved, 12);
    assert.equal(stored.context_brief_chars, 0);
    assert.equal(stored.discard_marker_present, 0);
    assert.equal(stored.status, 'compressed');

    await db.close();
  });

  it('writes a skipped_under_budget row', async () => {
    const db = new Database(makeConfig());
    await db.connect();
    const pool = db.getPool();

    const row = makeRow({
      compactedParts: 0,
      tokensSaved: 0,
      savedPercent: 0,
      status: 'skipped_under_budget',
    });
    await writeCompactionMetric(pool, row);

    const result = await pool.query("SELECT status FROM compaction_metrics WHERE session_id = $1", [row.sessionId]);
    assert.equal(result.rows.length, 1);
    assert.equal((result.rows[0] as { status: string }).status, 'skipped_under_budget');

    await db.close();
  });

  it('writes a failed row', async () => {
    const db = new Database(makeConfig());
    await db.connect();
    const pool = db.getPool();

    const row = makeRow({
      compactedParts: 0,
      beforeChars: 0,
      afterChars: 0,
      beforeTokens: 0,
      afterTokens: 0,
      tokensSaved: 0,
      savedPercent: 0,
      semanticSignalCountPreserved: 0,
      status: 'failed',
    });
    await writeCompactionMetric(pool, row);

    const result = await pool.query("SELECT status FROM compaction_metrics WHERE session_id = $1", [row.sessionId]);
    assert.equal(result.rows.length, 1);
    assert.equal((result.rows[0] as { status: string }).status, 'failed');

    await db.close();
  });

  it('preserves explicit ISO-8601 timestamp', async () => {
    const db = new Database(makeConfig());
    await db.connect();
    const pool = db.getPool();

    const fixedTimestamp = '2026-07-12T10:30:00.000Z';
    const row = makeRow({ createdAt: fixedTimestamp });
    await writeCompactionMetric(pool, row);

    const result = await pool.query("SELECT created_at FROM compaction_metrics WHERE session_id = $1", [row.sessionId]);
    const stored = (result.rows[0] as { created_at: string }).created_at;
    assert.equal(stored, fixedTimestamp);

    await db.close();
  });

  it('writes all canonical and attribution columns correctly', async () => {
    const db = new Database(makeConfig());
    await db.connect();
    const pool = db.getPool();

    const row = makeRow();
    await writeCompactionMetric(pool, row);

    const result = await pool.query('SELECT * FROM compaction_metrics WHERE session_id = $1', [row.sessionId]);
    const stored = result.rows[0] as Record<string, unknown>;
    const expectedColumns = [
      'id', 'session_id', 'total_tool_parts', 'compacted_parts', 'skipped_parts',
      'before_chars', 'after_chars', 'before_tokens', 'after_tokens',
      'tokens_saved', 'saved_percent', 'semantic_signal_count_preserved',
      'context_brief_chars', 'discard_marker_present', 'status', 'created_at',
      'project_id', 'client_kind', 'runtime_kind', 'eligible_parts', 'persisted_parts',
      'failure_stage', 'failure_code', 'failure_message',
    ];
    for (const col of expectedColumns) {
      assert.ok(col in stored, `missing column: ${col}`);
    }

    await db.close();
  });
});

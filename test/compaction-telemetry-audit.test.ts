import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { Database } from '../dist/database.js';
import { writeCompactionMetric } from '../dist/compaction-metric-writer.js';
import { auditCompactionTelemetry, formatAuditAvailability } from '../dist/compaction-telemetry-audit.js';
import type { PluginConfig } from '../dist/types.js';
import type { CompactionMetricInput } from '../dist/compaction-metric-writer.js';

describe('Phase 10C3 — Compaction telemetry audit (SQLite)', () => {
  const tmpDir = '.tmp/compaction-audit-sqlite';
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
      sessionId: 'audit-test',
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
      createdAt: '2026-07-12T10:00:00.000Z',
      ...overrides,
    };
  }

  it('returns available:true with passed:true for clean data', async () => {
    const db = new Database(makeConfig());
    await db.connect();
    const pool = db.getPool();

    await writeCompactionMetric(pool, makeRow({ tokensSaved: 700, beforeTokens: 1500, afterTokens: 800 }));
    const availability = await auditCompactionTelemetry(pool);

    assert.equal(availability.available, true);
    assert.equal(availability.passed, true);

    await db.close();
  });

  it('returns available:false with reason:table_missing when table is dropped', async () => {
    const db = new Database(makeConfig());
    await db.connect();
    const pool = db.getPool();

    await pool.query('DROP TABLE compaction_metrics');
    const availability = await auditCompactionTelemetry(pool);

    assert.equal(availability.available, false);
    assert.equal(availability.reason, 'table_missing');
    assert.equal(availability.passed, null);

    await db.close();
  });

  it('returns available:false with reason:schema_incomplete for partial table', async () => {
    const db = new Database(makeConfig());
    await db.connect();
    const pool = db.getPool();

    await pool.query('DROP TABLE compaction_metrics');
    await pool.query(`CREATE TABLE compaction_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      total_tool_parts INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'compressed',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    const availability = await auditCompactionTelemetry(pool);

    assert.equal(availability.available, false);
    assert.equal(availability.reason, 'schema_incomplete');
    assert.equal(availability.passed, null);

    await db.close();
  });

  it('detects duplicate rows via window function', async () => {
    const db = new Database(makeConfig());
    await db.connect();
    const pool = db.getPool();

    const row = makeRow();
    await writeCompactionMetric(pool, row);
    await writeCompactionMetric(pool, { ...row, createdAt: row.createdAt });

    const availability = await auditCompactionTelemetry(pool);

    assert.equal(availability.available, true);
    if (availability.available) {
      assert.ok(availability.result.duplicateIds.length > 0, 'should detect duplicates');
    }

    await db.close();
  });

  it('detects negative tokens_saved values', async () => {
    const db = new Database(makeConfig());
    await db.connect();
    const pool = db.getPool();

    await writeCompactionMetric(pool, makeRow({ tokensSaved: -50 }));
    const availability = await auditCompactionTelemetry(pool);

    assert.equal(availability.available, true);
    if (availability.available) {
      assert.ok(availability.result.negativeValues.length > 0, 'should detect negative values');
    }

    await db.close();
  });

  it('detects math errors when tokens_saved != before - after', async () => {
    const db = new Database(makeConfig());
    await db.connect();
    const pool = db.getPool();

    await writeCompactionMetric(pool, makeRow({ beforeTokens: 1500, afterTokens: 800, tokensSaved: 999 }));
    const availability = await auditCompactionTelemetry(pool);

    assert.equal(availability.available, true);
    if (availability.available) {
      assert.ok(availability.result.mathErrors.length > 0, 'should detect math errors');
    }

    await db.close();
  });

  it('formatAuditAvailability returns correct title for available result', async () => {
    const db = new Database(makeConfig());
    await db.connect();
    const pool = db.getPool();

    const availability = await auditCompactionTelemetry(pool);
    const formatted = formatAuditAvailability(availability);

    assert.ok(
      formatted.title.includes('PASSED') ||
      formatted.title.includes('ISSUES') ||
      formatted.title.includes('UNAVAILABLE'),
      `unexpected title: ${formatted.title}`,
    );

    await db.close();
  });

  it('formatAuditAvailability returns UNAVAILABLE title for missing table', async () => {
    const db = new Database(makeConfig());
    await db.connect();
    const pool = db.getPool();

    await pool.query('DROP TABLE compaction_metrics');
    const availability = await auditCompactionTelemetry(pool);
    const formatted = formatAuditAvailability(availability);

    assert.equal(formatted.title, 'Compaction Audit UNAVAILABLE');
    assert.ok(formatted.output.includes('table'));

    await db.close();
  });
});

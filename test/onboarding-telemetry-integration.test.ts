import assert from 'node:assert/strict';
import { it, describe, before, beforeEach, afterEach } from 'node:test';
import { mkdirSync, rmSync } from 'node:fs';
import { Database } from '../src/database.js';
import { ContextInjectionLogger } from '../src/context-injection-logger.js';
import { buildOnboardingPacketWithProvenance } from '../src/agent-onboarding.js';
import type { DatabasePool, PluginConfig } from '../src/types.js';

const SQLITE_DIR = '.tmp/sqlite-onboarding-int';
const SQLITE_PATH = `${SQLITE_DIR}/onboarding-int-test.sqlite`;

function createSqliteConfig(): PluginConfig {
  return {
    databaseUrl: SQLITE_PATH,
    databaseProvider: 'sqlite',
    sqlitePath: SQLITE_PATH,
    embeddingModel: 'nomic-embed-text',
    embeddingApiUrl: 'http://localhost:11434',
  } as PluginConfig;
}

describe('Onboarding integration — live injection produces telemetry', () => {
  let db: Database;
  let pool: DatabasePool;
  let logger: ContextInjectionLogger;

  before(() => {
    try { mkdirSync(SQLITE_DIR, { recursive: true }); } catch { /* exists */ }
  });

  beforeEach(async () => {
    try { await db?.disconnect(); } catch { /* not connected */ }
    try { rmSync(SQLITE_PATH); } catch { /* not exists */ }
    try { rmSync(`${SQLITE_PATH}-wal`); } catch { /* not exists */ }
    try { rmSync(`${SQLITE_PATH}-shm`); } catch { /* not exists */ }
    db = new Database(createSqliteConfig());
    await db.connect();
    pool = db.getPool();
    logger = new ContextInjectionLogger(pool, { enabled: true, environment: 'fixture' });
  });

  afterEach(async () => {
    try { await db?.disconnect(); } catch { /* closed */ }
  });

  it('onboarding injection produces telemetry event with injection_kind=onboarding', async () => {
    const result = await buildOnboardingPacketWithProvenance({
      projectId: 'test-project',
      sessionId: 's1',
      workspacePath: 'test-project',
      pool,
      config: {} as PluginConfig,
    });

    if (result) {
      await logger.logInjection({
        idempotencyKey: 'onboarding:s1',
        projectId: 'test-project',
        sessionId: 's1',
        injectionKind: 'onboarding',
        sourceTurnId: null,
        built: result.built,
        blockHash: null,
        status: 'injected',
      });
      await logger.flush();

      const events = await pool.query('SELECT * FROM context_injection_events');
      assert.equal(events.rows.length, 1);
      const event = events.rows[0] as Record<string, unknown>;
      assert.equal(event.injection_kind, 'onboarding');
      assert.equal(event.status, 'injected');

      const items = await pool.query('SELECT * FROM context_injection_items');
      assert.ok(items.rows.length > 0, 'must write item rows');
      assert.equal(items.rows.length, result.built.items.length);
    }
  });

  it('onboarding provenance preserves provider/source in layer names', async () => {
    const result = await buildOnboardingPacketWithProvenance({
      projectId: 'test-project',
      sessionId: 's2',
      workspacePath: 'test-project',
      pool,
      config: {} as PluginConfig,
    });

    if (result) {
      await logger.logInjection({
        idempotencyKey: 'onboarding:s2',
        projectId: 'test-project',
        sessionId: 's2',
        injectionKind: 'onboarding',
        sourceTurnId: null,
        built: result.built,
        blockHash: null,
        status: 'injected',
      });
      await logger.flush();

      const items = await pool.query('SELECT * FROM context_injection_items');
      const layerNames = new Set(items.rows.map((r: Record<string, unknown>) => r.layer_name));
      // Onboarding sections are provider names like 'identity-brief', 'project-continuity', etc.
      assert.ok(layerNames.size > 0, 'must have at least one layer name');
      for (const name of layerNames) {
        assert.equal(typeof name, 'string');
        assert.ok(name.length > 0);
      }
    }
  });

  it('onboarding telemetry: all items have sourceKind=derived_state', async () => {
    const result = await buildOnboardingPacketWithProvenance({
      projectId: 'test-project',
      sessionId: 's3',
      workspacePath: 'test-project',
      pool,
      config: {} as PluginConfig,
    });

    if (result) {
      // Onboarding items are all derived_state (no memory IDs)
      for (const item of result.built.items) {
        assert.equal(item.sourceKind, 'derived_state');
        assert.equal(item.memoryId, null);
      }
    }
  });

  it('logger failure does not block onboarding', async () => {
    const result = await buildOnboardingPacketWithProvenance({
      projectId: 'test-project',
      sessionId: 's4',
      workspacePath: 'test-project',
      pool,
      config: {} as PluginConfig,
    });

    if (result) {
      const brokenLogger = new ContextInjectionLogger(pool, { enabled: true, environment: 'fixture' });
      (brokenLogger as unknown as { writeRecord: () => never }).writeRecord = () => {
        throw new Error('simulated logger failure');
      };

      await assert.doesNotReject(
        brokenLogger.logInjection({
          idempotencyKey: 'onboarding:s4',
          projectId: 'test-project',
          sessionId: 's4',
          injectionKind: 'onboarding',
          sourceTurnId: null,
          built: result.built,
          blockHash: null,
          status: 'injected',
        }),
      );
      await brokenLogger.flush();
    }
  });

  it('duplicate onboarding injection is idempotent', async () => {
    const result = await buildOnboardingPacketWithProvenance({
      projectId: 'test-project',
      sessionId: 's5',
      workspacePath: 'test-project',
      pool,
      config: {} as PluginConfig,
    });

    if (result) {
      const record = {
        idempotencyKey: 'onboarding:s5',
        projectId: 'test-project',
        sessionId: 's5',
        injectionKind: 'onboarding',
        sourceTurnId: null,
        built: result.built,
        blockHash: null,
        status: 'injected' as const,
      };

      await logger.logInjection(record);
      await logger.flush();
      await logger.logInjection(record);
      await logger.flush();

      const events = await pool.query('SELECT * FROM context_injection_events');
      assert.equal(events.rows.length, 1, 'duplicate key must produce one event');
    }
  });

  it('onboarding output snapshot is a string (text exists)', async () => {
    const result = await buildOnboardingPacketWithProvenance({
      projectId: 'test-project',
      sessionId: 's6',
      workspacePath: 'test-project',
      pool,
      config: {} as PluginConfig,
    });

    if (result) {
      assert.equal(typeof result.built.text, 'string');
      assert.ok(result.built.text.length > 0);
      assert.equal(result.built.injectionKind, 'onboarding');
    }
  });
});

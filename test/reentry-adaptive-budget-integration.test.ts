import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { describe, it } from 'node:test';
import { Database } from '../src/database.js';
import { ReEntryProtocol } from '../src/re-entry-protocol.js';
import { ContextInjectionLogger } from '../src/context-injection-logger.js';
import { MemoryManager } from '../src/memory-manager.js';
import { SelfModelUpdater } from '../src/self-model-updater.js';
import { BeliefKnowledgeConsolidator } from '../src/belief-knowledge-store.js';
import { AgentWorkJournal } from '../src/agent-work-journal.js';
import type { DatabasePool, PluginConfig } from '../src/types.js';

const PG_URL = process.env.CSM_DATABASE_URL ?? '';
const SQLITE_DIR = '.tmp/sqlite-adaptive-budget';
const SQLITE_PATH = `${SQLITE_DIR}/adaptive-budget.sqlite`;

interface AdaptiveFixture {
  db: Database;
  key: string;
  pool: DatabasePool;
  priorId: string;
  projectId: string;
  sessionId: string;
}

function config(provider: 'postgres' | 'sqlite', databaseUrl: string): PluginConfig {
  return {
    databaseUrl, databaseProvider: provider, sqlitePath: databaseUrl,
    embeddingModel: 'nomic-embed-text', embeddingApiUrl: 'http://localhost:11434',
  } as PluginConfig;
}

async function openFixture(provider: 'postgres' | 'sqlite', databaseUrl: string): Promise<AdaptiveFixture> {
  const id = randomUUID();
  const sessionId = `adaptive-current-${id}`;
  const priorId = `adaptive-prior-${id}`;
  const projectId = `adaptive-budget-project-${id}`;
  const db = new Database(config(provider, databaseUrl));
  try {
    await db.connect();
    const pool = db.getPool();
    await pool.query(
      `INSERT INTO sessions (id, project_id, turn_count, updated_at) VALUES ($1, $2, $3, $4)`,
      [priorId, projectId, 8, '2026-07-14T10:00:00.000Z'],
    );
    return { db, pool, priorId, projectId, sessionId, key: `reentry:${sessionId}` };
  } catch (error) {
    await db.disconnect();
    throw error;
  }
}

function protocol(pool: DatabasePool): ReEntryProtocol {
  return new ReEntryProtocol({
    pool, memoryManager: new MemoryManager(pool), selfModel: new SelfModelUpdater(pool),
    beliefStore: new BeliefKnowledgeConsolidator(pool), workJournal: new AgentWorkJournal(pool),
    config: { enabled: true, previewOnly: false },
  });
}

async function assertShortTier(fixture: AdaptiveFixture): Promise<void> {
  const reentry = protocol(fixture.pool);
  const diagnostic = await reentry.diagnose(fixture.sessionId, fixture.projectId);
  const built = await reentry.buildBlockWithProvenance(fixture.sessionId, fixture.projectId);
  assert.ok(built !== null);
  assert.deepEqual([diagnostic.budgetTier, diagnostic.priorSessionTurns, diagnostic.budgetChars], ['short', 8, 1260]);
  const logger = new ContextInjectionLogger(fixture.pool, { enabled: true, environment: 'fixture' });
  await logger.logInjection({
    idempotencyKey: fixture.key, projectId: fixture.projectId, sessionId: fixture.sessionId,
    injectionKind: 'reentry', sourceTurnId: null, built, blockHash: null, status: 'injected',
  });
  await logger.flush();
  const event = await fixture.pool.query(
    'SELECT metadata FROM context_injection_events WHERE idempotency_key = $1', [fixture.key],
  );
  const raw = event.rows[0].metadata;
  const metadata = typeof raw === 'string' ? JSON.parse(raw) as Record<string, unknown> : raw as Record<string, unknown>;
  assert.deepEqual([metadata.budgetTier, metadata.priorSessionTurns, metadata.effectiveMaxChars], ['short', 8, 1260]);
}

async function closeFixture(fixture: AdaptiveFixture): Promise<void> {
  try {
    await fixture.pool.query('DELETE FROM context_injection_events WHERE idempotency_key = $1', [fixture.key]);
  } finally {
    try { await fixture.pool.query('DELETE FROM sessions WHERE id = $1', [fixture.priorId]); }
    finally { await fixture.db.disconnect(); }
  }
}

describe('Re-entry adaptive budget integration', () => {
  it('selects and persists the short-session tier in SQLite', async () => {
    mkdirSync(SQLITE_DIR, { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) { try { rmSync(`${SQLITE_PATH}${suffix}`); } catch {} }
    const fixture = await openFixture('sqlite', SQLITE_PATH);
    try { await assertShortTier(fixture); }
    finally {
      await closeFixture(fixture);
      for (const suffix of ['', '-wal', '-shm']) { try { rmSync(`${SQLITE_PATH}${suffix}`); } catch {} }
    }
  });

  it('selects and persists the short-session tier in PostgreSQL', { skip: !PG_URL }, async () => {
    const fixture = await openFixture('postgres', PG_URL);
    try { await assertShortTier(fixture); }
    finally { await closeFixture(fixture); }
  });
});

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { AgentWorkJournal } from '../dist/agent-work-journal.js';
import { DEFAULT_CONFIG } from '../dist/config.js';
import { Database } from '../dist/database.js';

const BASE_URL = process.env.CSM_DATABASE_URL ?? process.env.DATABASE_URL
  ?? 'postgresql://postgres:postgres@localhost:5432/cross_session_memory';
const TMP_DIR = '.tmp/work-journal-integration';
const SQLITE_PATH = `${TMP_DIR}/journal.sqlite`;
const PG_NAME = `csm_journal_${Date.now()}_${randomUUID().slice(0, 8)}`.replace(/-/g, '_');
let admin: Pool;

before(async () => {
  mkdirSync(TMP_DIR, { recursive: true });
  cleanSqlite();
  admin = new Pool({ connectionString: databaseUrl('postgres') });
  await admin.query(`CREATE DATABASE ${quoteIdentifier(PG_NAME)}`);
});

after(async () => {
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
    [PG_NAME]);
  await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(PG_NAME)}`);
  await admin.end();
  cleanSqlite();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

it('preserves a flushed work-journal entry across a real PostgreSQL restart', async () => {
  await proveRestart(postgresConfig(), 'postgres-restart');
});

it('preserves a flushed work-journal entry across a persistent SQLite restart', async () => {
  await proveRestart(sqliteConfig(), 'sqlite-restart');
});

async function proveRestart(
  config: typeof DEFAULT_CONFIG,
  intent: string,
): Promise<void> {
  const first = new Database(config);
  await first.connect();
  const journal = new AgentWorkJournal(first.getPool(), config.workJournal);
  journal.recordDecision({ sessionId: 'restart-session', projectId: 'restart-project', intent,
    filesTouched: ['src/restart-proof.ts'] });
  journal.recordDecision({ sessionId: 'restart-session', projectId: 'restart-project',
    intent: `${intent}-second`, filesTouched: ['src/second-proof.ts'] });
  await journal.flush();
  await first.close();

  const reopened = new Database(config);
  await reopened.connect();
  const result = await reopened.getPool().query(
    'SELECT intent FROM agent_work_journal WHERE session_id = $1',
    ['restart-session'],
  );
  assert.equal(result.rows.length, 2);
  const reader = new AgentWorkJournal(reopened.getPool(), config.workJournal);
  const entries = await reader.getRecentEntries('restart-session', 2);
  assert.deepEqual(entries.map((entry) => entry.intent), [`${intent}-second`, intent]);
  assert.deepEqual(entries[0]?.filesTouched, ['src/second-proof.ts']);
  assert.equal(entries.every((entry) => entry.createdAt instanceof Date), true);
  await reopened.close();
}

function postgresConfig(): typeof DEFAULT_CONFIG {
  return { ...DEFAULT_CONFIG, databaseProvider: 'postgres', databaseUrl: databaseUrl(PG_NAME) };
}

function sqliteConfig(): typeof DEFAULT_CONFIG {
  return { ...DEFAULT_CONFIG, databaseProvider: 'sqlite', databaseUrl: SQLITE_PATH,
    sqlitePath: SQLITE_PATH };
}

function cleanSqlite(): void {
  for (const path of [SQLITE_PATH, `${SQLITE_PATH}-wal`, `${SQLITE_PATH}-shm`]) {
    try { rmSync(path); } catch { /* absent */ }
  }
}

function databaseUrl(name: string): string {
  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

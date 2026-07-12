import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { Database } from '../dist/database.js';
import { bridgeToolNames, assertBridgeExtraSupported } from '../dist/codex-bridge-capabilities.js';
import { DEFAULT_CONFIG } from '../dist/config.js';
import { CONTRACT_SESSION_ID, registerContractAssertions } from './compaction-contract-assertions.js';

const BASE_URL = process.env.CSM_DATABASE_URL ?? process.env.DATABASE_URL
  ?? 'postgresql://postgres:postgres@localhost:5432/cross_session_memory';
const SQLITE_DIR = '.tmp/compaction-contract';
const SQLITE_PATH = `${SQLITE_DIR}/contract.sqlite`;
const PG_NAME = `csm_compaction_${randomUUID().slice(0, 8)}`.replace(/-/g, '_');
let admin: Pool;
let postgres: Database;
let sqlite: Database;

function dbUrl(name: string): string {
  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function cleanSqlite(): void {
  for (const path of [SQLITE_PATH, `${SQLITE_PATH}-wal`, `${SQLITE_PATH}-shm`]) {
    try { rmSync(path); } catch { /* absent */ }
  }
}

describe('Phase 10C4 - compaction telemetry contract', () => {
  before(async () => {
    mkdirSync(SQLITE_DIR, { recursive: true });
    cleanSqlite();
    admin = new Pool({ connectionString: dbUrl('postgres') });
    await admin.query(`CREATE DATABASE ${quoteIdentifier(PG_NAME)}`);
    postgres = new Database({ ...DEFAULT_CONFIG, databaseProvider: 'postgres', databaseUrl: dbUrl(PG_NAME) });
    sqlite = new Database({ ...DEFAULT_CONFIG, databaseProvider: 'sqlite', databaseUrl: SQLITE_PATH, sqlitePath: SQLITE_PATH });
    await postgres.connect();
    await postgres.getPool().query(
      'INSERT INTO sessions (id, project_id, title) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [CONTRACT_SESSION_ID, 'compaction-contract', 'Compaction telemetry contract'],
    );
    await sqlite.connect();
  });

  after(async () => {
    await postgres.close();
    await sqlite.close();
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [PG_NAME]);
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(PG_NAME)}`);
    await admin.end();
    cleanSqlite();
    rmSync(SQLITE_DIR, { recursive: true, force: true });
  });

  describe('PostgreSQL', () => registerContractAssertions(() => postgres.getPool(), false));
  describe('SQLite', () => registerContractAssertions(() => sqlite.getPool(), true));

  it('exposes csm_compaction_audit through the SQLite bridge only after the contract gate', () => {
    assert.ok(bridgeToolNames('sqlite').includes('csm_compaction_audit'));
    assert.doesNotThrow(() => assertBridgeExtraSupported('sqlite', 'csm_compaction_audit'));
  });
});

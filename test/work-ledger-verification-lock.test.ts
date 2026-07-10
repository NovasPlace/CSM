import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { DEFAULT_CONFIG } from '../src/config.js';
import { Database } from '../src/database.js';
import { WorkLedger } from '../src/work-ledger.js';
import type { WorkLedgerCaptureInput } from '../src/work-ledger-types.js';

const BASE_URL = process.env.CSM_DATABASE_URL
  ?? 'postgresql://postgres:postgres@localhost:5432/cross_session_memory';
const NAME = `csm_work_ledger_verify_lock_${Date.now()}`;
const ROOT = resolve(`.tmp/work-ledger-verify-lock-${process.pid}`);
const FILE = resolve(ROOT, 'tracked.txt');
const admin = new Pool({ connectionString: url('postgres') });
let database: Database;
let ledger: WorkLedger;

function url(name: string): string {
  const value = new URL(BASE_URL);
  value.pathname = `/${name}`;
  return value.toString();
}

function capture(runId: string, callId: string): WorkLedgerCaptureInput {
  return {
    runId, sessionId: 'verify-session', modelId: 'model', toolCallId: callId,
    toolName: 'edit', projectRoot: ROOT, args: { filePath: 'tracked.txt' },
  };
}

before(async () => {
  await admin.query(`CREATE DATABASE "${NAME}"`);
  database = new Database({ ...DEFAULT_CONFIG, databaseUrl: url(NAME) });
  await database.connect();
  await database.getPool().query(
    'INSERT INTO sessions (id, project_id, title) VALUES ($1, $2, $3)',
    ['verify-session', ROOT, 'verification lock'],
  );
  ledger = new WorkLedger(database.getPool(), {
    enabled: true, maxFileBytes: 1_000_000, captureTimeoutMs: 5_000,
  });
  await mkdir(ROOT, { recursive: true });
  await writeFile(FILE, 'base\n');
});

after(async () => {
  await ledger.dispose();
  await database.close();
  await rm(ROOT, { recursive: true, force: true });
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [NAME]);
  await admin.query(`DROP DATABASE IF EXISTS "${NAME}"`);
  await admin.end();
});

it('waits for an active capture before refreshing monotonic survival', async () => {
  const original = capture('run-original', 'call-original');
  await ledger.captureBefore(original);
  await writeFile(FILE, 'base\nowned\n');
  await ledger.captureAfter(original);
  const mutator = capture('run-mutator', 'call-mutator');
  await ledger.captureBefore(mutator);
  await writeFile(FILE, 'base\n');
  let queryFinished = false;
  const query = ledger.listSurvivingChanges('run-original', ROOT)
    .then((changes) => { queryFinished = true; return changes; });
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(queryFinished, false);
  await writeFile(FILE, 'base\nowned\nunrelated\n');
  await ledger.captureAfter(mutator);
  const changes = await query;
  assert.equal(changes.length, 1);
  assert.equal(changes[0].status, 'active');
});

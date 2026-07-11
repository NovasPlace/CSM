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
const NAME = `csm_work_ledger_new_alias_${Date.now()}`;
const ROOT = resolve(`.tmp/work-ledger-new-alias-${process.pid}`);
const FILE = resolve(ROOT, 'new-file.ts');
const admin = new Pool({ connectionString: databaseUrl('postgres') });
let database: Database | undefined;
let firstLedger: WorkLedger;
let secondLedger: WorkLedger;

function databaseUrl(name: string): string {
  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

function capture(runId: string, callId: string, filePath: string): WorkLedgerCaptureInput {
  return {
    runId, sessionId: 'alias-session', modelId: 'model', toolCallId: callId,
    toolName: 'write', projectRoot: ROOT, args: { filePath },
  };
}

before(async () => {
  if (process.platform !== 'win32') return;
  await admin.query(`CREATE DATABASE "${NAME}"`);
  database = new Database({ ...DEFAULT_CONFIG, databaseUrl: databaseUrl(NAME) });
  await database.connect();
  await database.getPool().query(
    'INSERT INTO sessions (id, project_id, title) VALUES ($1, $2, $3)',
    ['alias-session', ROOT, 'new-file alias'],
  );
  const config = { enabled: true, maxFileBytes: 1_000_000, captureTimeoutMs: 5_000 };
  firstLedger = new WorkLedger(database.getPool(), config);
  secondLedger = new WorkLedger(database.getPool(), config);
  await mkdir(ROOT, { recursive: true });
});

after(async () => {
  if (process.platform !== 'win32') {
    await admin.end();
    return;
  }
  await database?.close();
  await rm(ROOT, { recursive: true, force: true });
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [NAME]);
  await admin.query(`DROP DATABASE IF EXISTS "${NAME}"`);
  await admin.end();
});

it('serializes concurrent differently-cased creates as one file', {
  skip: process.platform !== 'win32',
}, async () => {
  const lower = capture('run-new-lower', 'call-lower', 'new-file.ts');
  const upper = capture('run-new-upper', 'call-upper', 'NEW-FILE.TS');
  await firstLedger.captureBefore(lower);
  let upperReady = false;
  const waiting = secondLedger.captureBefore(upper).then(() => { upperReady = true; });
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(upperReady, false);
  await writeFile(FILE, 'export const owner = "lower";\n');
  const [change] = await firstLedger.captureAfter(lower);
  await waiting;
  assert.equal(upperReady, true);
  assert.equal(change.filePath, 'new-file.ts');
  assert.equal(await secondLedger.abortCapture(upper), true);
});

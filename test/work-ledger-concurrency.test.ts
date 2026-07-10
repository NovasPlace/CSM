import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { DEFAULT_CONFIG } from '../src/config.js';
import { Database } from '../src/database.js';
import { WorkLedger } from '../src/work-ledger.js';
import { CodexMemoryBridge } from '../src/codex-bridge.js';
import type { WorkLedgerCaptureInput } from '../src/work-ledger-types.js';

const BASE_URL = process.env.CSM_DATABASE_URL
  ?? 'postgresql://postgres:postgres@localhost:5432/cross_session_memory';
const DATABASE_NAME = `csm_work_ledger_concurrency_${Date.now()}`;
const ROOT = resolve(`.tmp/work-ledger-concurrency-${process.pid}`);
const FILE = resolve(ROOT, 'tracked.txt');
const admin = new Pool({ connectionString: databaseUrl('postgres') });
let database: Database | undefined;
let firstLedger: WorkLedger;
let secondLedger: WorkLedger;

function databaseUrl(name: string): string {
  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function capture(runId: string, callId: string, root = ROOT): WorkLedgerCaptureInput {
  return {
    runId, sessionId: 'concurrency-session', modelId: 'openai:gpt-5-codex',
    toolCallId: callId, toolName: 'edit', projectRoot: root,
    args: { filePath: 'tracked.txt' },
  };
}

before(async () => {
  await admin.query(`CREATE DATABASE ${quoteIdentifier(DATABASE_NAME)}`);
  database = new Database({
    ...DEFAULT_CONFIG,
    databaseUrl: databaseUrl(DATABASE_NAME),
    databaseProvider: 'postgres',
  });
  await database.connect();
  await database.getPool().query(
    'INSERT INTO sessions (id, project_id, title) VALUES ($1, $2, $3)',
    ['concurrency-session', ROOT, 'Work Ledger concurrency'],
  );
  const config = { enabled: true, maxFileBytes: 1_000_000, captureTimeoutMs: 1_000 };
  firstLedger = new WorkLedger(database.getPool(), config);
  secondLedger = new WorkLedger(database.getPool(), config);
  await mkdir(ROOT, { recursive: true });
  await writeFile(FILE, 'base\n');
});

after(async () => {
  try { if (database) await database.close(); } finally {
    await rm(ROOT, { recursive: true, force: true });
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [DATABASE_NAME]);
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(DATABASE_NAME)}`);
    await admin.end();
  }
});

it('serializes overlapping capture windows before filesystem mutation', async () => {
  const first = capture('run-overlap-a', 'call-a');
  const second = capture('run-overlap-b', 'call-b');
  await firstLedger.captureBefore(first);
  let secondReady = false;
  const waiting = secondLedger.captureBefore(second).then(() => { secondReady = true; });
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(secondReady, false);
  await writeFile(FILE, 'base\nowned-a\n');
  const [firstChange] = await firstLedger.captureAfter(first);
  await waiting;
  assert.equal(secondReady, true);
  await writeFile(FILE, 'base\nowned-a\nowned-b\n');
  const [secondChange] = await secondLedger.captureAfter(second);
  assert.equal(secondChange.beforeHash, firstChange.afterHash);
  assert.notEqual(secondChange.afterHash, firstChange.afterHash);
});

it('correlates concurrent equal call IDs independently by project', async () => {
  const otherRoot = resolve(ROOT, 'repo-b');
  const otherFile = resolve(otherRoot, 'tracked.txt');
  await mkdir(otherRoot, { recursive: true });
  await writeFile(otherFile, 'base\n');
  const first = capture('run-same', 'same-call');
  const second = capture('run-same', 'same-call', otherRoot);
  await Promise.all([firstLedger.captureBefore(first), firstLedger.captureBefore(second)]);
  await Promise.all([writeFile(FILE, 'base\nrepo-a\n'), writeFile(otherFile, 'base\nrepo-b\n')]);
  const [a, b] = await Promise.all([
    firstLedger.captureAfter(first), firstLedger.captureAfter(second),
  ]);
  assert.equal(a[0].projectRoot, ROOT);
  assert.equal(b[0].projectRoot, otherRoot);
});

it('bridge disconnect releases an unfinished capture lease', async () => {
  const bridge = await CodexMemoryBridge.connect({
    ...DEFAULT_CONFIG, databaseUrl: databaseUrl(DATABASE_NAME), databaseProvider: 'postgres',
  });
  await bridge.beginWorkChange(capture('run-disconnect', 'call-disconnect'));
  const result = await Promise.race([
    bridge.disconnect().then(() => 'disconnected'),
    new Promise<string>((done) => setTimeout(() => done('timeout'), 1_000)),
  ]);
  assert.equal(result, 'disconnected');
});

it('expires an abandoned capture lease within its configured bound', async () => {
  const expiring = new WorkLedger(database!.getPool(), {
    enabled: true, maxFileBytes: 1_000_000, captureTimeoutMs: 1_000,
  });
  const abandoned = capture('run-expired', 'call-expired');
  await expiring.captureBefore(abandoned);
  await new Promise((done) => setTimeout(done, 1_100));
  await assert.rejects(() => expiring.captureAfter(abandoned), /no matching pending capture/);
  await secondLedger.captureBefore(capture('run-after-expiry', 'call-after-expiry'));
  await secondLedger.abortCapture(capture('run-after-expiry', 'call-after-expiry'));
});

it('canonicalizes a symlinked project root for capture and query', async () => {
  const alias = resolve(`${ROOT}-alias`);
  await symlink(ROOT, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const input = capture('run-root-alias', 'call-root-alias', alias);
  try {
    await firstLedger.captureBefore(input);
    await writeFile(FILE, 'base\nroot-alias\n');
    await firstLedger.captureAfter(input);
    const changes = await firstLedger.listSurvivingChanges('run-root-alias', alias);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].projectRoot, await realpath(ROOT));
  } finally {
    await rm(alias, { recursive: true, force: true });
  }
});

it('serializes Windows case aliases as one physical file', {
  skip: process.platform !== 'win32',
}, async () => {
  const first = capture('run-case-a', 'call-case-a');
  const second = {
    ...capture('run-case-b', 'call-case-b'), args: { filePath: 'TRACKED.TXT' },
  };
  await firstLedger.captureBefore(first);
  let aliasReady = false;
  const waiting = secondLedger.captureBefore(second).then(() => { aliasReady = true; });
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(aliasReady, false);
  await writeFile(FILE, 'base\ncase-a\n');
  await firstLedger.captureAfter(first);
  await waiting;
  assert.equal(aliasReady, true);
  await secondLedger.abortCapture(second);
});

it('rejects changed completion file arguments and releases the lease', async () => {
  const input = capture('run-path-mismatch', 'call-path-mismatch');
  await firstLedger.captureBefore(input);
  await assert.rejects(
    () => firstLedger.captureAfter({ ...input, args: { filePath: 'different.txt' } }),
    /completion paths do not match/,
  );
  const next = capture('run-after-mismatch', 'call-after-mismatch');
  await secondLedger.captureBefore(next);
  assert.equal(await secondLedger.abortCapture(next), true);
});

it('rolls back every row when a later file in one tool call fails', async () => {
  const secondFile = resolve(ROOT, 'atomic-b.txt');
  await writeFile(FILE, 'base\n');
  await writeFile(secondFile, 'base\n');
  await database!.getPool().query(`
    CREATE FUNCTION fail_atomic_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.file_path = 'atomic-b.txt' THEN RAISE EXCEPTION 'atomic failure'; END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER fail_atomic_ledger BEFORE INSERT ON work_ledger_changes
    FOR EACH ROW EXECUTE FUNCTION fail_atomic_ledger()
  `);
  const input = {
    ...capture('run-atomic', 'call-atomic'),
    args: { files: [{ filePath: 'tracked.txt' }, { filePath: 'atomic-b.txt' }] },
  };
  await firstLedger.captureBefore(input);
  await Promise.all([writeFile(FILE, 'changed\n'), writeFile(secondFile, 'changed\n')]);
  await assert.rejects(() => firstLedger.captureAfter(input), /atomic failure/);
  const result = await database!.getPool().query(
    'SELECT COUNT(*)::int AS count FROM work_ledger_changes WHERE run_id = $1', ['run-atomic']);
  assert.equal(result.rows[0].count, 0);
});

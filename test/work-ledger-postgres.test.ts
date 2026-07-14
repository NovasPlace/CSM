import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DEFAULT_CONFIG } from '../src/config.js';
import { Database } from '../src/database.js';
import { WorkLedger } from '../src/work-ledger.js';
import { CodexMemoryBridge } from '../dist/codex-bridge.js';
import type { WorkLedgerCaptureInput, WorkLedgerChange } from '../src/work-ledger-types.js';

const BASE_URL = process.env.CSM_DATABASE_URL
  ?? 'postgresql://postgres:postgres@localhost:5432/cross_session_memory';
const DATABASE_NAME = `csm_work_ledger_${process.pid}_${randomUUID().replaceAll('-', '')}`;
const ROOT = resolve(`.tmp/work-ledger-${process.pid}`);
const FILE = resolve(ROOT, 'tracked.txt');
const admin = new Pool({ connectionString: databaseUrl('postgres') });
let database: Database | undefined;
let ledger: WorkLedger;
let firstChange: WorkLedgerChange;
let secondChange: WorkLedgerChange;
function databaseUrl(name: string): string {
  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
function capture(runId: string, callId: string, modelId: string): WorkLedgerCaptureInput {
  return {
    runId,
    sessionId: 'ledger-session',
    modelId,
    toolCallId: callId,
    toolName: 'edit',
    projectRoot: ROOT,
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
    ['ledger-session', ROOT, 'Work Ledger test'],
  );
  ledger = new WorkLedger(database.getPool(), {
    enabled: true, maxFileBytes: 1_000_000, captureTimeoutMs: 1_000,
  });
  await mkdir(ROOT, { recursive: true });
  await writeFile(FILE, 'base\n');
});

after(async () => {
  const errors: unknown[] = [];
  try { if (database) await database.close(); } catch (error) { errors.push(error); }
  try { await rm(ROOT, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  try {
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [DATABASE_NAME]);
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(DATABASE_NAME)}`);
  } catch (error) { errors.push(error); }
  try { await admin.end(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Work Ledger fixture cleanup failed');
});

it('records exact run, model, tool, file, and hash provenance', async () => {
  const input = capture('run-a', 'call-a', 'openai:gpt-5-codex');
  await ledger.captureBefore(input);
  await writeFile(FILE, 'base\nowned-a\nowned-b\n');
  [firstChange] = await ledger.captureAfter(input);
  assert.equal(firstChange.runId, 'run-a');
  assert.equal(firstChange.modelId, 'openai:gpt-5-codex');
  assert.equal(firstChange.toolCallId, 'call-a');
  assert.equal(firstChange.filePath, 'tracked.txt');
  assert.match(firstChange.beforeHash ?? '', /^[a-f0-9]{64}$/);
  assert.match(firstChange.afterHash ?? '', /^[a-f0-9]{64}$/);
  assert.equal(firstChange.status, 'active');
  assert.equal(firstChange.survivingPatchHash, firstChange.patchHash);
});

it('links a later run that partially supersedes the first change', async () => {
  const input = capture('run-b', 'call-b', 'anthropic:claude');
  await ledger.captureBefore(input);
  await writeFile(FILE, 'base\nowned-a\nreplacement\n');
  [secondChange] = await ledger.captureAfter(input);
  const surviving = await ledger.listSurvivingChanges('run-a', ROOT);
  assert.equal(surviving.length, 1);
  assert.equal(surviving[0].status, 'partially_superseded');
  assert.ok(surviving[0].supersededBy.includes(secondChange.changeId));
  assert.ok(secondChange.supersedes.includes(firstChange.changeId));
});

it('removes an exactly reverted change from the surviving-run query', async () => {
  const input = capture('run-c', 'call-c', 'google:gemini');
  await ledger.captureBefore(input);
  await writeFile(FILE, 'base\n');
  const [revertChange] = await ledger.captureAfter(input);
  const surviving = await ledger.listSurvivingChanges('run-a', ROOT);
  assert.equal(surviving.length, 0);
  const result = await database?.getPool().query(
    'SELECT status, superseded_by FROM work_ledger_changes WHERE change_id = $1',
    [firstChange.changeId],
  );
  assert.equal(result?.rows[0].status, 'reverted');
  assert.ok((result?.rows[0].superseded_by as string[]).includes(revertChange.changeId));
});

it('does not resurrect prior ownership when identical content is reintroduced', async () => {
  await writeFile(FILE, 'base\nowned-a\nowned-b\n');
  const surviving = await ledger.listSurvivingChanges('run-a', ROOT);
  assert.equal(surviving.length, 0);
});

it('supports explicit two-phase capture through the Codex bridge', async () => {
  const bridge = await CodexMemoryBridge.connect({
    ...DEFAULT_CONFIG,
    databaseUrl: databaseUrl(DATABASE_NAME),
    databaseProvider: 'postgres',
  });
  const input = {
    runId: 'run-codex',
    modelId: 'openai:gpt-5-codex',
    toolCallId: 'codex-call-1',
    toolName: 'apply_patch',
    projectRoot: ROOT,
    args: { filePath: 'tracked.txt' },
  };
  try {
    await bridge.beginWorkChange(input);
    await writeFile(FILE, 'base\ncodex-owned\n');
    const completed = await bridge.completeWorkChange(input);
    const surviving = await bridge.getSurvivingWorkChanges({ runId: 'run-codex', projectRoot: ROOT });
    const commitSha = 'a'.repeat(40);
    const correlated = await bridge.correlateWorkChangesToCommit({
      changeIds: completed.map((change) => change.changeId), commitSha });
    assert.equal(correlated, 1);
    assert.equal(completed.length, 1);
    assert.equal(surviving.length, 1);
    assert.ok(bridge.listTools().includes('work_ledger_surviving'));
    const row = await database?.getPool().query(
      'SELECT session_id, commit_sha FROM work_ledger_changes WHERE run_id = $1', ['run-codex']);
    assert.match(String(row?.rows[0].session_id), /^codex-/);
    assert.equal(row?.rows[0].commit_sha, commitSha);
  } finally {
    await bridge.disconnect();
  }
});

it('detects untracked supersession without inventing a superseding run', async () => {
  await writeFile(FILE, 'base\nowned-a\nowned-b\nexternal-untracked\n');
  const surviving = await ledger.listSurvivingChanges('run-codex', ROOT);
  assert.equal(surviving.length, 0);
  const result = await database?.getPool().query(
    `SELECT status, superseded_by
     FROM work_ledger_changes WHERE run_id = $1`,
    ['run-codex'],
  );
  assert.equal(result?.rows[0].status, 'superseded');
  assert.deepEqual(result?.rows[0].superseded_by, []);
});

it('keeps idempotency isolated by project root', async () => {
  const otherRoot = resolve(ROOT, 'repo-b');
  const otherFile = resolve(otherRoot, 'tracked.txt');
  await mkdir(otherRoot, { recursive: true });
  await writeFile(otherFile, 'base\n');
  const input = { ...capture('run-a', 'call-a', 'openai:gpt-5-codex'), projectRoot: otherRoot };
  await ledger.captureBefore(input);
  await writeFile(otherFile, 'base\nrepo-b-owned\n');
  const [change] = await ledger.captureAfter(input);
  assert.equal(change.projectRoot, otherRoot);
  const result = await database?.getPool().query(
    'SELECT COUNT(*)::int AS count FROM work_ledger_changes WHERE run_id = $1 AND tool_call_id = $2',
    ['run-a', 'call-a'],
  );
  assert.equal(result?.rows[0].count, 2);
});

it('does not advertise or execute disabled bridge ledger operations', async () => {
  const bridge = await CodexMemoryBridge.connect({
    ...DEFAULT_CONFIG,
    databaseUrl: databaseUrl(DATABASE_NAME),
    workLedger: { ...DEFAULT_CONFIG.workLedger, enabled: false },
  });
  try {
    assert.ok(!bridge.listTools().includes('work_ledger_surviving'));
    await assert.rejects(
      () => bridge.getSurvivingWorkChanges({ runId: 'disabled' }),
      /Work Ledger is disabled/,
    );
  } finally {
    await bridge.disconnect();
  }
});

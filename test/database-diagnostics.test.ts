import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { Database } from '../src/database.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const TMP_DIR = '.tmp/database-diagnostics';
const DB_PATH = `${TMP_DIR}/diagnostics.sqlite`;

function cleanTemporaryDatabase(): void {
  for (const path of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try { rmSync(path); } catch { /* absent */ }
  }
  try { rmSync(TMP_DIR); } catch { /* not empty or absent */ }
}

it('reports machine-readable startup, liveness, and readiness states', async () => {
  cleanTemporaryDatabase();
  mkdirSync(TMP_DIR, { recursive: true });
  const database = new Database({
    ...DEFAULT_CONFIG,
    databaseProvider: 'sqlite',
    databaseUrl: DB_PATH,
    sqlitePath: DB_PATH,
  });
  const idle = await database.diagnose();
  assert.equal(idle.startup.state, 'idle');
  assert.equal(idle.liveness.status, 'pass');
  assert.equal(idle.readiness.reason, 'not_connected');
  await database.connect();
  const ready = await database.diagnose();
  assert.equal(ready.startup.state, 'ready');
  assert.equal(ready.readiness.status, 'pass');
  assert.ok(ready.readiness.latencyMs >= 0);
  await database.close();
  const closed = await database.diagnose();
  assert.equal(closed.startup.state, 'closed');
  assert.equal(closed.readiness.reason, 'not_connected');
  cleanTemporaryDatabase();
});

it('retains a machine-readable failed startup state', async () => {
  cleanTemporaryDatabase();
  mkdirSync(TMP_DIR, { recursive: true });
  const database = new Database({
    ...DEFAULT_CONFIG,
    databaseProvider: 'sqlite',
    databaseUrl: TMP_DIR,
    sqlitePath: TMP_DIR,
  });
  await assert.rejects(() => database.connect());
  const diagnostic = await database.diagnose();
  assert.equal(diagnostic.startup.state, 'failed');
  assert.match(diagnostic.startup.error ?? '', /Error/);
  assert.equal(diagnostic.liveness.status, 'pass');
  assert.equal(diagnostic.readiness.reason, 'not_connected');
  cleanTemporaryDatabase();
});

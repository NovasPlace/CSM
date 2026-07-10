import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireCaptureLease,
  releaseCaptureLease,
} from '../src/work-ledger-capture-lock.js';
import type { DatabaseClient, DatabasePool } from '../src/types.js';

function failingClient(failAcquire = false) {
  const calls: string[] = [];
  let destroyed = false;
  const client: DatabaseClient = {
    async query(sql: string) {
      calls.push(sql);
      if (failAcquire && sql.includes('pg_advisory_lock') && calls.filter((item) => item.includes('pg_advisory_lock')).length > 1) {
        throw new Error('acquire failed');
      }
      if (sql.includes('pg_advisory_unlock(')) throw new Error('unlock failed');
      return { rows: [], rowCount: 0 };
    },
    release(error?: Error) { destroyed = !!error; },
  };
  return { client, calls, destroyed: () => destroyed };
}

it('destroys a client and unlocks all when lease release is uncertain', async () => {
  const fixture = failingClient();
  await assert.rejects(
    () => releaseCaptureLease({
      client: fixture.client, projectRoot: 'root', filePaths: ['a', 'b'],
    }),
    /lock cleanup failed/,
  );
  assert.equal(fixture.calls.filter((sql) => sql.includes('pg_advisory_unlock(')).length, 2);
  assert.ok(fixture.calls.some((sql) => sql.includes('pg_advisory_unlock_all')));
  assert.equal(fixture.destroyed(), true);
});

it('destroys a client when acquisition cleanup cannot unlock normally', async () => {
  const fixture = failingClient(true);
  const pool = { connect: async () => fixture.client } as DatabasePool;
  await assert.rejects(
    () => acquireCaptureLease(pool, 'root', ['a', 'b']),
    /acquisition cleanup failed/,
  );
  assert.ok(fixture.calls.some((sql) => sql.includes('pg_advisory_unlock_all')));
  assert.equal(fixture.destroyed(), true);
});

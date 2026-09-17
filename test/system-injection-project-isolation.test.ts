import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { injectDirectMemoryEvidence } from '../src/hooks/system-transform-live-evidence.js';
import { MemoryGovernance } from '../src/memory_governance.js';

describe('system injection project isolation', () => {
  it('scopes every direct memory-evidence query to the active project', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: mock.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes('SELECT COUNT(*) as cnt FROM memories')) {
          return { rows: [{ cnt: 0 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const ctx = {
      directory: '/workspace/project-b',
      database: {
        dialect: 'pg',
        getPool: () => pool,
      },
    };
    const output = { system: [] as string[] };

    await injectDirectMemoryEvidence(ctx as never, output as never);

    assert.equal(calls.length, 4);
    for (const call of calls) {
      assert.equal(call.params[0], '/workspace/project-b');
      if (call.sql.includes('FROM sessions s')) {
        assert.match(call.sql, /s\.project_id = \$1/);
        assert.match(call.sql, /m\.project_id = \$1/);
      } else {
        assert.match(call.sql, /project_id = \$1/);
      }
    }
  });

  it('scopes governance veto selection to the active project', async () => {
    let capturedSql = '';
    let capturedParams: unknown[] = [];
    const pool = {
      query: mock.fn(async (sql: string, params: unknown[] = []) => {
        capturedSql = sql;
        capturedParams = params;
        return { rows: [], rowCount: 0 };
      }),
    };

    const governance = new MemoryGovernance(pool as never, '/workspace/project-b');
    await governance.evaluate();

    assert.match(capturedSql, /project_id = \$1/);
    assert.deepEqual(capturedParams, ['/workspace/project-b']);
  });
});

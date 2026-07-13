import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { TokenBudgetLedger } from '../src/token-budget-ledger.js';

const DB_URL = process.env.CSM_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory';
const SESSION_ID = `test-token-ledger-${Date.now()}`;
const SECOND_SESSION_ID = `${SESSION_ID}-2`;
const SESSION_IDS = [SESSION_ID, SECOND_SESSION_ID];

describe('TokenBudgetLedger', () => {
  const pool = new Pool({ connectionString: DB_URL }) as any;
  let ledger: TokenBudgetLedger;
  let baselineWeeklyInput = 0;
  let baselineWeeklyOutput = 0;
  let baselineWeeklyTokens = 0;

  before(async () => {
    await pool.query('DELETE FROM session_token_usage WHERE session_id = ANY($1)', [SESSION_IDS]);
    const baselineLedger = new TokenBudgetLedger(pool, 1_000_000);
    await baselineLedger.ensureSchema();
    const baseline = await baselineLedger.getWeeklyUsage();
    baselineWeeklyInput = baseline.totalInputTokens;
    baselineWeeklyOutput = baseline.totalOutputTokens;
    baselineWeeklyTokens = baseline.totalTokens;
    ledger = new TokenBudgetLedger(pool, baselineWeeklyTokens + 500_000);
    await ledger.ensureSchema();
  });

  after(async () => {
    await pool.query('DELETE FROM session_token_usage WHERE session_id = ANY($1)', [SESSION_IDS]);
    await pool.end();
  });

  it('records and retrieves session usage', async () => {
    await ledger.recordUsage({ sessionId: SESSION_ID, inputTokens: 50000, outputTokens: 10000, turnCount: 5 });
    await ledger.recordUsage({ sessionId: SESSION_ID, inputTokens: 30000, outputTokens: 8000, turnCount: 3 });

    const usage = await ledger.getSessionUsage(SESSION_ID);
    assert.equal(usage.sessionId, SESSION_ID);
    assert.equal(usage.totalInputTokens, 80000);
    assert.equal(usage.totalOutputTokens, 18000);
    assert.equal(usage.totalTokens, 98000);
    assert.equal(usage.turnCount, 8);
    assert.equal(usage.weeklyQuota, baselineWeeklyTokens + 500_000);
    assert.ok(usage.weeklyUsed >= 98000);
    assert.ok(usage.weeklyRemaining <= usage.weeklyQuota - 98000);
    assert.equal(usage.overQuota, false);
  });

  it('reports weekly usage across sessions', async () => {
    await ledger.recordUsage({ sessionId: SECOND_SESSION_ID, inputTokens: 20000, outputTokens: 5000, turnCount: 2 });
    const weekly = await ledger.getWeeklyUsage();
    assert.ok(weekly.totalInputTokens >= baselineWeeklyInput + 100000);
    assert.ok(weekly.totalOutputTokens >= baselineWeeklyOutput + 23000);
    assert.ok(weekly.totalTokens >= baselineWeeklyTokens + 123000);
    assert.ok(weekly.days >= 1);
  });

  it('detects over-quota usage', async () => {
    const smallLedger = new TokenBudgetLedger(pool, 10);
    const usage = await smallLedger.getSessionUsage(SESSION_ID);
    assert.equal(usage.overQuota, true);
    assert.equal(usage.weeklyRemaining, 0);
  });
});

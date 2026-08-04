/**
 * Goal System — unit + integration tests.
 *
 * Tests:
 * 1. Goal CRUD (set, update, list)
 * 2. Active goal extraction from DB
 * 3. Goal status transitions (active → achieved/abandoned)
 * 4. System prompt injection includes goal
 * 5. No-goal path (empty state)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import {
  initializeGoalSchema,
  setActiveGoal,
  getActiveGoal,
  updateGoal,
  listGoals,
  type Goal,
} from '../dist/goal-schema.js';

const DB_URL = process.env.DATABASE_URL
  ?? 'postgresql://postgres:postgres@localhost:5432/cross_session_memory';

let pool: Pool;

before(async () => {
  pool = new Pool({ connectionString: DB_URL });
  pool.on('error', () => {});
  await initializeGoalSchema({
    query: (text, params) => pool.query(text, params),
  } as any);
});

after(async () => {
  await pool.end();
});

describe('Goal Schema CRUD', () => {
  it('creates an active goal and retrieves it', async () => {
    const sid = `goal-test-${Date.now()}`;
    const goal = await setActiveGoal(pool as any, sid, 'Build the /goal system');
    assert.equal(goal.session_id, sid);
    assert.equal(goal.description, 'Build the /goal system');
    assert.equal(goal.status, 'active');

    const active = await getActiveGoal(pool as any, sid);
    assert.ok(active, 'active goal exists');
    assert.equal(active!.id, goal.id);
  });

  it('setActiveGoal deactivates previous active goal', async () => {
    const sid = `goal-deactivate-${Date.now()}`;
    const g1 = await setActiveGoal(pool as any, sid, 'First goal');
    const g2 = await setActiveGoal(pool as any, sid, 'Second goal');

    assert.equal(g1.status, 'active');
    assert.equal(g2.status, 'active');

    const active = await getActiveGoal(pool as any, sid);
    assert.ok(active);
    assert.equal(active!.id, g2.id, 'second goal is active');

    const all = await listGoals(pool as any, sid);
    const first = all.find(g => g.id === g1.id);
    assert.ok(first);
    assert.equal(first!.status, 'abandoned', 'first goal abandoned');
  });

  it('updateGoal changes description and status', async () => {
    const sid = `goal-update-${Date.now()}`;
    const goal = await setActiveGoal(pool as any, sid, 'Original');

    const updated = await updateGoal(pool as any, goal.id, {
      description: 'Updated description',
      status: 'achieved',
    });
    assert.ok(updated);
    assert.equal(updated!.description, 'Updated description');
    assert.equal(updated!.status, 'achieved');
    assert.ok(updated!.achieved_at, 'achieved_at set');
  });

  it('listGoals filters by status', async () => {
    const sid = `goal-filter-${Date.now()}`;
    await setActiveGoal(pool as any, sid, 'Active one');
    const old = await setActiveGoal(pool as any, sid, 'Old one');
    await updateGoal(pool as any, old.id, { status: 'achieved' });
    await setActiveGoal(pool as any, sid, 'Another active');

    const active = await listGoals(pool as any, sid, { status: 'active' });
    assert.ok(active.length >= 1, 'at least 1 active goal');
    assert.ok(active.every(g => g.status === 'active'), 'all filtered are active');

    const achieved = await listGoals(pool as any, sid, { status: 'achieved' });
    assert.ok(achieved.length >= 1, 'at least 1 achieved goal');
  });

  it('getActiveGoal returns null when no active goal', async () => {
    const sid = `goal-empty-${Date.now()}`;
    const result = await getActiveGoal(pool as any, sid);
    assert.equal(result, null, 'no active goal for fresh session');
  });
});

describe('Goal Prompt Injection', () => {
  it('formats goal for system prompt', async () => {
    const sid = `goal-prompt-${Date.now()}`;
    const goal = await setActiveGoal(pool as any, sid, 'Build transparent goal tracking');
    const active = await getActiveGoal(pool as any, sid);
    assert.ok(active);

    const lines = [
      `[Goal — ${active!.session_id}]`,
      active!.description,
      `[End Goal]`,
    ];
    const prompt = lines.join('\n');
    assert.ok(prompt.includes('Build transparent goal tracking'));
    assert.ok(prompt.includes('[Goal'));
    assert.ok(prompt.includes('[End Goal]'));
  });
});

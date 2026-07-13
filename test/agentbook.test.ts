import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { Database } from '../dist/database.js';
import { AgentBookEventStore } from '../dist/agentbook-event-store.js';
import { AgentBookRulesStore } from '../dist/agentbook-rules-store.js';
import { AgentBookStateProjector } from '../dist/agentbook-state-projector.js';
import { AgentBookSummaryGenerator } from '../dist/agentbook-summary-generator.js';
import { generateFrontPage } from '../dist/agentbook-frontpage.js';
import type { AgentBookEventInput, AgentBookCurrentState, AgentBookEvent, AgentBookRule, AgentBookEventType } from '../dist/agentbook-types.js';

const SQLITE_DIR = '.tmp/agentbook-test';
const SQLITE_PATH = `${SQLITE_DIR}/agentbook-test.sqlite`;

async function setup() {
  mkdirSync(SQLITE_DIR, { recursive: true });
  const database = new Database({
    databaseProvider: 'sqlite',
    sqlitePath: SQLITE_PATH,
  } as any);
  await database.connect();

  const eventStore = new AgentBookEventStore(database.getPool());
  const rulesStore = new AgentBookRulesStore(database.getPool());
  const stateProjector = new AgentBookStateProjector(database.getPool(), eventStore);
  const summaryGenerator = new AgentBookSummaryGenerator(database.getPool(), eventStore);

  return { database, eventStore, rulesStore, stateProjector, summaryGenerator };
}

describe('AgentBookEventStore', () => {
  let database: Database;
  let eventStore: AgentBookEventStore;

  before(async () => {
    const ctx = await setup();
    database = ctx.database;
    eventStore = ctx.eventStore;
  });

  after(async () => {
    await database.close();
    rmSync(SQLITE_DIR, { recursive: true, force: true });
  });

  it('appends an event and reads it back', async () => {
    const event = await eventStore.append({
      projectId: 'test-project',
      sessionId: 'ses_001',
      eventType: 'decision',
      summary: 'Use SQLite for testing',
      evidenceRefs: ['commit:abc123'],
      files: ['src/test.ts'],
      metadata: { reason: 'zero-dependency' },
    });
    assert.ok(event.eventId.startsWith('evt_'));
    assert.equal(event.projectId, 'test-project');
    assert.equal(event.eventType, 'decision');
    assert.equal(event.summary, 'Use SQLite for testing');
    assert.deepEqual(event.evidenceRefs, ['commit:abc123']);
    assert.deepEqual(event.files, ['src/test.ts']);
    assert.equal(event.status, 'active');

    const fetched = await eventStore.getEvent(event.eventId);
    assert.ok(fetched);
    assert.equal(fetched!.eventId, event.eventId);
    assert.equal(fetched!.summary, 'Use SQLite for testing');
  });

  it('lists events by project', async () => {
    await eventStore.append({ projectId: 'test-project', eventType: 'note', summary: 'Second event' });
    await eventStore.append({ projectId: 'other-project', eventType: 'note', summary: 'Third event' });

    const events = await eventStore.listEvents({ projectId: 'test-project', limit: 10 });
    assert.ok(events.length >= 2);
    assert.ok(events.every((e) => e.projectId === 'test-project'));
  });

  it('filters by event type', async () => {
    await eventStore.append({ projectId: 'test-project', eventType: 'file_modified', summary: 'Edited file' });
    const modifications = await eventStore.listEvents({ projectId: 'test-project', eventType: 'file_modified' });
    assert.ok(modifications.length >= 1);
    assert.ok(modifications.every((e) => e.eventType === 'file_modified'));
  });

  it('counts events and sessions', async () => {
    const eventCount = await eventStore.countEvents('test-project');
    const sessionCount = await eventStore.countSessions('test-project');
    assert.ok(eventCount >= 3);
    assert.ok(sessionCount >= 1);
  });

  it('rejects empty projectId', async () => {
    await assert.rejects(
      eventStore.append({ projectId: '', eventType: 'note', summary: 'fail' }),
    );
  });

  it('rejects empty summary', async () => {
    await assert.rejects(
      eventStore.append({ projectId: 'test-project', eventType: 'note', summary: '' }),
    );
  });
});

describe('AgentBookRulesStore', () => {
  let database: Database;
  let rulesStore: AgentBookRulesStore;

  before(async () => {
    const ctx = await setup();
    database = ctx.database;
    rulesStore = ctx.rulesStore;
  });

  after(async () => {
    await database.close();
    rmSync(SQLITE_DIR, { recursive: true, force: true });
  });

  it('adds and retrieves a rule', async () => {
    const rule = await rulesStore.addRule({
      instruction: 'Never commit without running tests',
      priority: 90,
      scope: 'project',
    });
    assert.ok(rule.ruleId.startsWith('rule_'));
    assert.equal(rule.instruction, 'Never commit without running tests');
    assert.equal(rule.priority, 90);
    assert.equal(rule.active, true);
    assert.equal(rule.version, 1);

    const fetched = await rulesStore.getRule(rule.ruleId);
    assert.ok(fetched);
    assert.equal(fetched!.instruction, rule.instruction);
  });

  it('lists active rules', async () => {
    await rulesStore.addRule({ instruction: 'Stop on scope expansion', priority: 80 });
    const active = await rulesStore.getActiveRules();
    assert.ok(active.length >= 2);
    assert.ok(active.every((r) => r.active));
  });

  it('deactivates a rule', async () => {
    const rule = await rulesStore.addRule({ instruction: 'Temporary rule', priority: 10 });
    await rulesStore.deactivateRule(rule.ruleId);
    const fetched = await rulesStore.getRule(rule.ruleId);
    assert.ok(fetched);
    assert.equal(fetched!.active, false);
  });

  it('rejects empty instruction', async () => {
    await assert.rejects(rulesStore.addRule({ instruction: '' }));
  });

  it('updates rule fields and bumps version', async () => {
    const rule = await rulesStore.addRule({ instruction: 'Original', priority: 50 });
    const updated = await rulesStore.updateRule(rule.ruleId, { priority: 75, instruction: 'Updated' });
    assert.equal(updated.priority, 75);
    assert.equal(updated.instruction, 'Updated');
    assert.equal(updated.version, 2);
  });
});

describe('AgentBookStateProjector', () => {
  let database: Database;
  let eventStore: AgentBookEventStore;
  let stateProjector: AgentBookStateProjector;

  before(async () => {
    const ctx = await setup();
    database = ctx.database;
    eventStore = ctx.eventStore;
    stateProjector = ctx.stateProjector;
  });

  after(async () => {
    await database.close();
    rmSync(SQLITE_DIR, { recursive: true, force: true });
  });

  it('projects current state from events', async () => {
    await eventStore.append({
      projectId: 'state-test',
      eventType: 'goal_set',
      summary: 'Test the state projector',
      metadata: { goal: 'Test the state projector' },
    });
    await eventStore.append({
      projectId: 'state-test',
      eventType: 'file_modified',
      summary: 'Changed config',
      files: ['config.ts'],
    });
    await eventStore.append({
      projectId: 'state-test',
      eventType: 'blocker_identified',
      summary: 'Database connection fails',
    });

    const state = await stateProjector.project('state-test');
    assert.equal(state.projectId, 'state-test');
    assert.ok(state.activeGoal);
    assert.ok(state.recentChanges.length > 0);
    assert.ok(state.blockers.length > 0);
    assert.ok(state.eventCount >= 3);
  });

  it('resolves blockers when blocker_resolved fires', async () => {
    await eventStore.append({
      projectId: 'blocker-test',
      eventType: 'blocker_identified',
      summary: 'Build broken',
    });
    await eventStore.append({
      projectId: 'blocker-test',
      eventType: 'blocker_resolved',
      summary: 'Build broken',
    });

    const state = await stateProjector.project('blocker-test');
    assert.equal(state.blockers.length, 0);
  });

  it('persists state and reads it back', async () => {
    const state = await stateProjector.project('state-test');
    const fetched = await stateProjector.getState('state-test');
    assert.ok(fetched);
    assert.equal(fetched!.projectId, 'state-test');
    assert.equal(fetched!.eventCount, state.eventCount);
  });
});

describe('AgentBookSummaryGenerator', () => {
  let database: Database;
  let eventStore: AgentBookEventStore;
  let summaryGenerator: AgentBookSummaryGenerator;

  before(async () => {
    const ctx = await setup();
    database = ctx.database;
    eventStore = ctx.eventStore;
    summaryGenerator = ctx.summaryGenerator;
  });

  after(async () => {
    await database.close();
    rmSync(SQLITE_DIR, { recursive: true, force: true });
  });

  it('does not generate summary below threshold', async () => {
    const result = await summaryGenerator.maybeGenerate('small-project');
    assert.equal(result, null);
  });

  it('generates summary when threshold is met', async () => {
    for (let i = 0; i < 55; i++) {
      await eventStore.append({
        projectId: 'summary-test',
        eventType: 'note',
        summary: `Event number ${i}`,
      });
    }
    const summary = await summaryGenerator.maybeGenerate('summary-test');
    assert.ok(summary);
    assert.ok(summary!.summaryId.startsWith('summary_'));
    assert.ok(summary!.eventCount >= 50);
    assert.ok(summary!.sourceHash.length === 64);
  });

  it('retrieves latest summary', async () => {
    const latest = await summaryGenerator.getLatestSummary('summary-test');
    assert.ok(latest);
    assert.ok(latest!.summaryId.startsWith('summary_'));
  });

  it('lists summaries', async () => {
    const summaries = await summaryGenerator.listSummaries('summary-test', 10);
    assert.ok(summaries.length >= 1);
  });
});

describe('generateFrontPage', () => {
  it('produces markdown with all sections', () => {
    const state: AgentBookCurrentState = {
      projectId: 'frontpage-test',
      activeGoal: 'Test the front page',
      currentPhase: 'Testing',
      latestSummaryId: null,
      recentChanges: ['Added tests', 'Fixed bug'],
      blockers: ['CI is flaky'],
      nextSteps: ['Fix CI', 'Deploy'],
      rulesVersion: 1,
      updatedAt: new Date().toISOString(),
      eventCount: 42,
      sessionCount: 3,
    };
    const rules: AgentBookRule[] = [{
      ruleId: 'rule_1',
      scope: 'project',
      priority: 90,
      trigger: null,
      instruction: 'Always run tests',
      overridePolicy: 'augment',
      version: 1,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }];
    const events: AgentBookEvent[] = [{
      eventId: 'evt_1',
      projectId: 'frontpage-test',
      sessionId: null,
      eventType: 'milestone',
      timestamp: new Date().toISOString(),
      actor: 'agent',
      summary: 'Reached milestone',
      evidenceRefs: [],
      files: [],
      command: null,
      result: null,
      environment: {},
      metadata: {},
      status: 'active',
    }];

    const frontPage = generateFrontPage(state, null, rules, events);
    assert.ok(frontPage.markdown.includes('# AgentBook'));
    assert.ok(frontPage.markdown.includes('frontpage-test'));
    assert.ok(frontPage.markdown.includes('Test the front page'));
    assert.ok(frontPage.markdown.includes('frontpage-test'));
    assert.ok(frontPage.markdown.includes('CI is flaky'));
    assert.ok(frontPage.markdown.includes('Always run tests'));
    assert.ok(frontPage.markdown.includes('Fix CI') || frontPage.markdown.includes('Define the next concrete action'));
    assert.ok(frontPage.markdown.includes('Reached milestone'));
    assert.ok(frontPage.hash.length > 0);
    assert.equal(frontPage.eventCount, 42);
  });

  it('handles empty state gracefully', () => {
    const state: AgentBookCurrentState = {
      projectId: 'empty',
      activeGoal: null,
      currentPhase: null,
      latestSummaryId: null,
      recentChanges: [],
      blockers: [],
      nextSteps: [],
      rulesVersion: 0,
      updatedAt: new Date().toISOString(),
      eventCount: 0,
      sessionCount: 0,
    };
    const frontPage = generateFrontPage(state, null, [], []);
    assert.ok(frontPage.markdown.includes('No active goal'));
    assert.ok(frontPage.markdown.includes('No recent work'));
    assert.ok(frontPage.markdown.includes('No active blockers'));
    assert.ok(frontPage.markdown.includes('No active AgentBook rules'));
  });
});

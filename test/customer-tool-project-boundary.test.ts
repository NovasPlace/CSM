import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { onboardAgentTool } from '../dist/agent-onboarding-tool.js';
import { agentBookEventsTool, agentBookStateTool } from '../dist/agentbook-tool.js';
import { beliefScanTool } from '../dist/belief-scan-tool.js';
import { goalUpdateTool } from '../dist/goal-tools.js';
import {
  memoryDistillTool, memoryLessonTool, memorySaveTool, recallQualityReportTool,
  reentryPreviewTool,
} from '../dist/tools.js';
import { workLedgerSurvivingTool } from '../dist/work-ledger-tool.js';

describe('customer-facing tools bind data access to their registered project', () => {
  it('does not expose another project through AgentBook event IDs', async () => {
    const listCalls: Array<Record<string, unknown>> = [];
    const eventStore = {
      async getEvent() {
        return {
          eventId: 'event-b', projectId: 'project-b', sessionId: null,
          eventType: 'note', timestamp: new Date().toISOString(), actor: 'agent',
          summary: 'project-b secret', evidenceRefs: [], files: [], command: null,
          result: null, environment: {}, metadata: {}, status: 'active',
        };
      },
      async listEvents(options: Record<string, unknown>) {
        listCalls.push(options);
        return [];
      },
    } as any;

    const definition = agentBookEventsTool(eventStore, 'project-a');
    assert.equal('projectId' in definition.args, false);

    const fetched = await definition.execute(
      { action: 'get', eventId: 'event-b' },
      { sessionID: 'session-a' },
    );
    assert.equal(fetched.metadata.event, null);
    assert.equal(fetched.output.includes('project-b secret'), false);

    await definition.execute({ action: 'list' }, { sessionID: 'session-a' });
    assert.equal(listCalls[0]?.projectId, 'project-a');
  });

  it('projects AgentBook state only for the bound workspace', async () => {
    const projected: string[] = [];
    const deps = {
      summaryGenerator: {
        async maybeGenerate(projectId: string) { projected.push(`summary:${projectId}`); },
        async getLatestSummary() { return null; },
      },
      stateProjector: {
        async project(projectId: string) {
          projected.push(`state:${projectId}`);
          return {
            projectId, activeGoal: null, currentPhase: null, latestSummaryId: null,
            recentChanges: [], blockers: [], nextSteps: [], rulesVersion: 0,
            updatedAt: new Date().toISOString(), eventCount: 0, sessionCount: 0,
          };
        },
      },
      rulesStore: { async getActiveRules() { return []; } },
      eventStore: {
        async getRecentEvents(projectId: string) {
          projected.push(`events:${projectId}`);
          return [];
        },
      },
    } as any;

    const definition = agentBookStateTool(deps, 'project-a', 'Z:\\missing-workspace');
    assert.equal('projectId' in definition.args, false);
    const result = await definition.execute({}, { sessionID: 'session-a' });

    assert.equal(result.metadata.state.projectId, 'project-a');
    assert.deepEqual(projected.sort(), ['events:project-a', 'state:project-a', 'summary:project-a']);
  });

  it('builds onboarding from the registered project and active session only', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      getDialect: () => 'pg',
      async query(sql: string, params: unknown[] = []) {
        queries.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
    };
    const projectId = 'C:\\customers\\alpha';
    const definition = onboardAgentTool({
      directory: projectId,
      database: { getPool: () => pool },
      config: {},
      state: { currentSessionId: 'stale-session' },
    } as any);

    assert.equal('projectId' in definition.args, false);
    assert.equal('sessionId' in definition.args, false);
    await definition.execute({ sections: ['relevant-memories', 'handoff-state'] }, { sessionID: 'active-session' });

    const memoryQuery = queries.find(({ sql }) => sql.includes('FROM memories') && sql.includes('importance >= 0.6'));
    assert.equal(memoryQuery?.params[0], projectId);

    const sessionQueries = queries.filter(({ sql }) => sql.includes('FROM sessions s'));
    assert.equal(sessionQueries.length, 1);
    assert.equal(sessionQueries[0].sql.includes(' LIKE '), false);
    assert.equal(sessionQueries[0].params.includes(projectId), true);
    assert.equal(sessionQueries[0].params.includes('active-session'), true);
  });

  it('attributes distilled memory candidates to the workspace, not the session', async () => {
    const extractionCalls: unknown[][] = [];
    const distiller = {
      distill: () => ({
        id: 'summary-1', groups: [{}], compressed: 'fixed the release path',
        totalCallsSummarized: 1, builtAt: new Date(),
      }),
    } as any;
    const extractor = {
      async extractFromDistilledSummaries(...args: unknown[]) {
        extractionCalls.push(args);
        return [];
      },
    } as any;
    const database = { getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }) } as any;
    const definition = memoryDistillTool(distiller, database, extractor, 'project-a');

    await definition.execute(
      { persist: false, extractMemories: true },
      { sessionID: 'session-a' },
    );

    assert.equal(extractionCalls[0]?.[0], 'session-a');
    assert.equal(extractionCalls[0]?.[1], 'project-a');
  });

  it('stamps manual memories and lessons with the registered project', async () => {
    const saves: Array<Record<string, unknown>> = [];
    const memoryManager = {
      async saveMemory(input: Record<string, unknown>) {
        saves.push(input);
        return { id: saves.length, importance: input.importance ?? 0.5, emotion: input.emotion ?? 'neutral' };
      },
    } as any;

    await memorySaveTool(memoryManager, 'project-a').execute(
      { content: 'customer decision', type: 'workspace' },
      { sessionID: 'session-a' },
    );
    await memoryLessonTool(memoryManager, 'project-a').execute(
      { content: 'verify the customer boundary' },
      { sessionID: 'session-a' },
    );

    assert.deepEqual(saves.map((save) => save.projectId), ['project-a', 'project-a']);
  });

  it('binds work-ledger and re-entry previews to the registered project', async () => {
    const ledgerCalls: unknown[][] = [];
    const ledger = {
      async listSurvivingChanges(...args: unknown[]) {
        ledgerCalls.push(args);
        return [];
      },
    } as any;
    const ledgerTool = workLedgerSurvivingTool(ledger, { runId: 'run-a' } as any, 'project-a');
    assert.equal('projectRoot' in ledgerTool.args, false);
    await ledgerTool.execute({ runId: 'run-a' }, { sessionID: 'session-a' });
    assert.deepEqual(ledgerCalls, [['run-a', 'project-a']]);

    const previewCalls: Array<Record<string, unknown>> = [];
    const adapter = {
      async buildPreviewReport(input: Record<string, unknown>) {
        previewCalls.push(input);
        return {
          previewOnly: true, wouldInject: false, blockBuilt: false, byteLength: 0,
          totalChars: 0, originalChars: 0, budgetChars: 0, approxTokens: 0,
          trimLevel: 0, layersIncluded: [], layersTrimmed: [], layersDropped: [], layerDetails: [],
        };
      },
      async formatReport(input: Record<string, unknown>) {
        previewCalls.push(input);
        return 'preview';
      },
    } as any;
    const previewTool = reentryPreviewTool(adapter, 'project-a');
    await previewTool.execute({}, { sessionID: 'session-a', directory: 'project-b' } as any);
    assert.deepEqual(previewCalls.map((call) => call.projectId), ['project-a', 'project-a']);
  });

  it('scopes explicit goal updates to the active session', async () => {
    const updates: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      async query(sql: string, params: unknown[]) {
        updates.push({ sql, params });
        if (sql.startsWith('SELECT 1 FROM goals')) {
          return { rows: [{ '?column?': 1 }], rowCount: 1 };
        }
        return {
          rows: [{
            id: 'goal-b', session_id: 'session-a', description: 'updated', status: 'active',
            context: {}, created_at: Date.now(), updated_at: Date.now(), achieved_at: null,
          }],
          rowCount: 1,
        };
      },
    };
    const definition = goalUpdateTool({ pool } as any);
    await definition.execute(
      { goalId: 'goal-b', description: 'updated' },
      { sessionID: 'session-a' },
    );

    assert.match(updates[0].sql, /WHERE id = \$1 AND session_id = \$2/);
    assert.equal(updates[0].params.includes('goal-b'), true);
    assert.equal(updates[0].params.includes('session-a'), true);
  });

  it('binds belief scans and recall reports to the workspace', async () => {
    const scans: Array<Record<string, unknown>> = [];
    const scanner = {
      async scan(config: Record<string, unknown>) {
        scans.push(config);
        return {
          dryRun: true, packetsScanned: 0, patternsFound: 0, candidates: [],
          inserted: 0, updated: 0, skippedDuplicates: 0, byType: {},
        };
      },
    } as any;
    const scanDefinition = beliefScanTool(scanner, 'project-a');
    assert.equal('projectId' in scanDefinition.args, false);
    await scanDefinition.execute({}, { sessionID: 'session-a' });
    assert.equal(scans[0]?.projectId, 'project-a');

    const database = {
      getPool: () => ({ getDialect: () => 'sqlite', query: async () => ({ rows: [], rowCount: 0 }) }),
    } as any;
    const reportDefinition = recallQualityReportTool(database, 'project-a');
    assert.equal('projectId' in reportDefinition.args, false);
    assert.equal('scope' in reportDefinition.args, false);
    const report = await reportDefinition.execute({}, { sessionID: 'session-a' });
    assert.equal(report.metadata.projectId, 'project-a');
    assert.equal(report.metadata.scope, 'project');
  });
});

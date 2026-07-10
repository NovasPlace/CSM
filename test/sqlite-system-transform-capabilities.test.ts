import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSystemTransformHook } from '../dist/hooks/system-transform.js';

describe('SQLite system transform capability boundaries', () => {
  it('does not issue PostgreSQL-only governance or goal queries', async () => {
    const sessionId = 'sqlite-transform-session';
    const queries: string[] = [];
    const pool = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
      getDialect: () => 'sqlite',
    };
    const pluginCtx = {
      state: {
        currentSessionId: null,
        messageCount: 0,
        capturedMessageSizes: new Map(),
        recentUserMessages: new Map(),
        sourceOnlySessions: new Set(),
        reentryInjected: new Set(),
        onboardingInjected: new Set([sessionId]),
      },
      database: { dialect: 'sqlite', getPool: () => pool },
      config: {
        databaseProvider: 'sqlite',
        livingState: { maxAdvisoryBlockChars: 600 },
        workJournal: { enabled: false, injectMaxTokens: 500 },
        selfContinuity: { enabled: false },
        contextCompiler: { statusInjection: false },
        contextCache: { enabled: false },
      },
      lessonTriggers: { refresh: async () => {}, buildFullSystemInjection: () => null },
      contextRecall: null,
      contextCapSensor: null,
      contextPressure: {
        getInfo: () => ({ estimatedTokens: 0, maxTokens: 128000, percentage: 0, action: 'OK' }),
      },
      reEntryProtocol: null,
      livingStateAdvisor: null,
      vcmManager: null,
      checkpointInjectDeps: null,
      lastCompileResult: null,
      directory: 'sqlite-transform-project',
      syncActiveSession: () => {},
    } as any;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 503 });

    try {
      await createSystemTransformHook(pluginCtx)({
        sessionID: sessionId,
        messages: [{ role: 'user', content: 'inspect memory state' }],
      }, { system: [] });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.ok(!queries.some((sql) => sql.includes("metadata ? 'governance'")));
    assert.ok(!queries.some((sql) => /FROM\s+goals/i.test(sql)));
  });
});

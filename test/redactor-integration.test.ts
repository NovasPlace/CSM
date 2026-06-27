import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Redactor } from '../dist/redactor.js';
import { AlchemistEngine } from '../dist/alchemist.js';
import type { AlchemistLesson } from '../dist/types.js';

function makeRedactor(): Redactor {
  return new Redactor({
    enabled: true,
    categories: {
      secret: true,
      email: true,
      phone: true,
      ip: true,
      urlCreds: true,
      path: 'normalize',
    },
    workspaceRoot: 'C:\\Users\\Donovan\\project',
  });
}

describe('Redactor integration — Alchemist', () => {
  it('store() redacts secrets from lesson text fields', () => {
    const redactor = makeRedactor();
    const engine = new AlchemistEngine({ maxLessons: 100 }, redactor);
    const secretKey = 'sk-proj-abc123def456ghi789jkl012mno345pqr';
    engine.store([{
      type: 'procedure',
      title: 'Test lesson',
      description: `Used key ${secretKey} to authenticate`,
      trigger: `When calling API with ${secretKey}`,
      action: `Set ${secretKey} in env var`,
      evidence: [`Found ${secretKey} in config`],
      confidence: 0.9,
      retention: 0.8,
      verified: false,
      verificationCount: 0,
      source: 'repo_scan',
      tags: [],
    }]);
    const lessons = engine.recall('API key authentication');
    assert.ok(lessons.length > 0, 'should recall at least one lesson');
    for (const lesson of lessons) {
      assert.ok(!lesson.description.includes(secretKey), 'description must not contain raw secret');
      assert.ok(!lesson.trigger.includes(secretKey), 'trigger must not contain raw secret');
      assert.ok(!lesson.action.includes(secretKey), 'action must not contain raw secret');
      for (const e of lesson.evidence) {
        assert.ok(!e.includes(secretKey), 'evidence must not contain raw secrets');
      }
    }
  });

  it('store() redacts emails from lesson fields', () => {
    const redactor = makeRedactor();
    const engine = new AlchemistEngine({ maxLessons: 100 }, redactor);
    const email = 'user@example.com';
    engine.store([{
      type: 'procedure',
      title: 'Email lesson',
      description: `Sent notification to ${email}`,
      trigger: `When emailing ${email}`,
      action: `Use ${email} as recipient`,
      evidence: [`CC'd ${email}`],
      confidence: 0.9,
      retention: 0.8,
      verified: false,
      verificationCount: 0,
      source: 'repo_scan',
      tags: [],
    }]);
    const lessons = engine.recall('email notification');
    assert.ok(lessons.length > 0, 'should recall at least one lesson');
    for (const lesson of lessons) {
      assert.ok(!lesson.description.includes(email), 'description must not contain raw email');
      assert.ok(!lesson.trigger.includes(email), 'trigger must not contain raw email');
      assert.ok(!lesson.action.includes(email), 'action must not contain raw email');
    }
  });
});

describe('Redactor integration — MemoryManager mock', () => {
  it('saveMemory() passes redacted content to INSERT', async () => {
    const redactor = makeRedactor();
    const secretKey = 'sk-proj-abc123def456ghi789jkl012mno345pqr';
    let capturedContent: string | null = null;

    const mockPool = {
      query: async (sql: string, params?: any[]) => {
        if (sql.includes('INSERT INTO memories') && sql.includes('RETURNING')) {
          capturedContent = params?.[3];
          return {
            rows: [{
              id: 1, session_id: 's1', project_id: null,
              memory_type: 'conversation', content: capturedContent,
              importance: 0.5, emotion: 'neutral', confidence: 1.0,
              source: 'manual', tags: [], linked_memory_ids: [],
              metadata: {}, created_at: new Date(), updated_at: new Date(),
              accessed_at: new Date(), access_count: 0,
            }],
          };
        }
        if (sql.includes('INSERT INTO memory_chunks')) return { rows: [] };
        if (sql.includes('INSERT INTO memory_links')) return { rows: [] };
        if (sql.includes('SELECT * FROM sessions')) return { rows: [] };
        if (sql.includes('INSERT INTO sessions')) return { rows: [{ id: 's1' }] };
        if (sql.includes('SELECT project_id')) return { rows: [] };
        return { rows: [] };
      },
      connect: () => ({
        query: mockPool.query,
        release: () => {},
      }),
    };

    const mockDb = { getPool: () => mockPool } as any;

    const { MemoryManager } = await import('../dist/memory-manager.js');
    const { EmbeddingGenerator } = await import('../dist/embeddings.js');

    const mockEmbeddings = {
      generate: async () => null,
    } as any;

    const mm = new MemoryManager(mockDb, mockEmbeddings, redactor);

    try {
      await mm.saveMemory({
        sessionId: 's1',
        type: 'conversation' as any,
        content: `Auth with key ${secretKey}`,
        importance: 0.5,
        emotion: 'neutral' as any,
        confidence: 1.0,
        source: 'manual' as any,
        tags: [],
      });
    } catch {}

    assert.ok(capturedContent !== null, 'INSERT should have been called');
    assert.ok(!capturedContent!.includes(secretKey), 'memory content must not contain raw secret');
    assert.ok(capturedContent!.includes('[REDACTED_SECRET]'), 'memory content should have redaction marker');
  });
});

describe('Redactor integration — CheckpointStore mock', () => {
  it('createCheckpoint() passes redacted summary to INSERT', async () => {
    const redactor = makeRedactor();
    const secretKey = 'sk-proj-abc123def456ghi789jkl012mno345pqr';
    let capturedSummary: string | null = null;
    let capturedRawContent: string | null = null;

    const mockClient = {
      query: async (sql: string, params?: any[]) => {
        if (sql === 'BEGIN') return;
        if (sql === 'COMMIT') return;
        if (sql === 'ROLLBACK') return;
        if (sql.includes('SELECT') && sql.includes('is_active') && sql.includes('FROM checkpoints')) {
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO checkpoints') && sql.includes('RETURNING')) {
          capturedSummary = params?.[4];
          return {
            rows: [{
              checkpoint_id: 'cp-1',
              session_id: params?.[0],
              project_id: params?.[1],
              created_at: new Date(),
              source_message_start: params?.[2],
              source_message_end: params?.[3],
              summary_markdown: capturedSummary,
              summary_tokens: params?.[5],
              input_tokens_estimate: params?.[6],
              source_refs: params?.[7] ? JSON.parse(params[7]) : [],
              compacted_refs: params?.[8] ? JSON.parse(params[8]) : [],
              files_mentioned: params?.[9] || [],
              tests_mentioned: params?.[10] || [],
              risks: params?.[11] ? JSON.parse(params[11]) : [],
              next_steps: params?.[12] ? JSON.parse(params[12]) : [],
              supersedes_checkpoint_id: params?.[13],
              schema_version: 1,
              is_active: true,
            }],
          };
        }
        if (sql.includes('INSERT INTO checkpoint_raw_captures')) {
          capturedRawContent = params?.[5];
          return { rows: [] };
        }
        return { rows: [] };
      },
      release: () => {},
    };

    const mockPool = {
      query: async () => ({ rows: [] }),
      connect: () => mockClient,
    };

    const { CheckpointStore } = await import('../dist/checkpoint-store.js');
    const store = new CheckpointStore(mockPool as any, redactor);

    const checkpoint = await store.createCheckpoint({
      sessionId: 's1',
      summaryMarkdown: `Checkpoint using key ${secretKey}`,
      summaryTokens: 10,
      inputTokensEstimate: 100,
      sourceRefs: [],
      compactedRefs: [],
      filesMentioned: [],
      testsMentioned: [],
      risks: [],
      nextSteps: [],
      rawCaptures: [{
        kind: 'tool_output',
        content: `Output with key ${secretKey}`,
        tokenCount: 50,
      }],
    });

    assert.ok(capturedSummary !== null, 'checkpoint INSERT should have been called');
    assert.ok(!capturedSummary!.includes(secretKey), 'checkpoint summary must not contain raw secret');
    assert.ok(capturedSummary!.includes('[REDACTED_SECRET]'), 'checkpoint summary should have redaction marker');

    assert.ok(capturedRawContent !== null, 'raw capture INSERT should have been called');
    assert.ok(!capturedRawContent!.includes(secretKey), 'raw capture content must not contain raw secret');
  });
});

describe('Redactor integration — context cache mock', () => {
  it('storeItem() passes redacted content to INSERT', async () => {
    const redactor = makeRedactor();
    const secretKey = 'sk-proj-abc123def456ghi789jkl012mno345pqr';
    let capturedSummary: string | null = null;
    let capturedContent: string | null = null;

    const mockPool = {
      query: async (sql: string, params?: any[]) => {
        if (sql.includes('INSERT INTO context_cache')) {
          capturedSummary = params?.[5];
          capturedContent = params?.[6];
          return { rows: [] };
        }
        return { rows: [] };
      },
    };

    const { storeItem } = await import('../dist/context-cache-store.js');

    await storeItem(mockPool as any, {
      sessionId: 's1',
      displayId: 'turn_1',
      kind: 'turn',
      createdAt: new Date().toISOString(),
      messageIndex: 0,
      summary: `Cache using key ${secretKey}`,
      content: `Content with key ${secretKey}`,
      metadata: {},
      tokens: 100,
    }, redactor);

    assert.ok(capturedSummary !== null, 'cache INSERT should have been called');
    assert.ok(!capturedSummary!.includes(secretKey), 'cache summary must not contain raw secret');
    assert.ok(capturedContent !== null, 'cache content should be captured');
    assert.ok(!capturedContent!.includes(secretKey), 'cache content must not contain raw secret');
  });
});

describe('Redactor integration — distilled summaries mock', () => {
  it('redacts compressed text before INSERT', () => {
    const redactor = makeRedactor();
    const secretKey = 'sk-proj-abc123def456ghi789jkl012mno345pqr';
    const original = `Summary with key ${secretKey}`;
    const result = redactor.redact(original);
    assert.ok(!result.text.includes(secretKey), 'distilled summary text must not contain raw secret');
    assert.ok(result.text.includes('[REDACTED_SECRET]'), 'distilled summary should have redaction marker');
  });
});

describe('Redactor integration — audit metadata', () => {
  it('audit contains counts but not raw secrets', () => {
    const redactor = makeRedactor();
    const secretKey = 'sk-proj-abc123def456ghi789jkl012mno345pqr';
    const email = 'user@example.com';
    const result = redactor.redact(`Key ${secretKey} and email ${email}`);
    assert.ok(result.audit.byCategory.secret > 0, 'audit should have secret count');
    assert.ok(result.audit.byCategory.email > 0, 'audit should have email count');
    const auditStr = JSON.stringify(result.audit);
    assert.ok(!auditStr.includes(secretKey), 'audit must not contain raw secret');
    assert.ok(!auditStr.includes(email), 'audit must not contain raw email');
  });
});

describe('Redactor integration — category toggles', () => {
  it('disabling a category skips redaction for it', () => {
    const redactor = new Redactor({
      enabled: true,
      categories: {
        secret: true,
        email: false,
        phone: false,
        ip: false,
        urlCreds: true,
        path: 'off',
      },
      workspaceRoot: 'C:\\Users\\Donovan\\project',
    });
    const email = 'user@example.com';
    const secretKey = 'sk-proj-abc123def456ghi789jkl012mno345pqr';
    const result = redactor.redact(`Key ${secretKey} and email ${email}`);
    assert.ok(!result.text.includes(secretKey), 'secrets should still be redacted');
    assert.ok(result.text.includes(email), 'email should NOT be redacted when category is disabled');
  });
});

describe('Redactor integration — fail-closed', () => {
  it('returns safe content when redaction encounters unexpected input', () => {
    const redactor = makeRedactor();
    const result = redactor.redact(null as any);
    assert.ok(typeof result.text === 'string', 'should return a string even for null input');
    assert.strictEqual(result.changed, false, 'should not be marked as changed');
  });
});

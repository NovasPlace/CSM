import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from '../dist/database.js';
import { Redactor, redactJsonValue } from '../dist/redactor.js';
import { MemoryManager } from '../dist/memory-manager.js';
import { EmbeddingBackfill } from '../dist/embedding-backfill.js';
import { hashRecallQuery } from '../dist/recall-telemetry.js';
import { memoryDistillTool, memorySaveTool } from '../dist/tools.js';
import { ExperiencePacketCreator } from '../dist/experience-packet.js';
import { AgentBookEventStore } from '../dist/agentbook-event-store.js';
import { AgentBookRulesStore } from '../dist/agentbook-rules-store.js';
import { AgentBookStateProjector } from '../dist/agentbook-state-projector.js';
import { AgentBookSummaryGenerator } from '../dist/agentbook-summary-generator.js';
import { generateFrontPage, writeFrontPageFile } from '../dist/agentbook-frontpage.js';
import { cacheToolErrorSignal } from '../dist/context-cache-signals.js';
import { fetchFileReads, fetchLastError, storeItem } from '../dist/context-cache-store.js';
import { writeBridgeTurnJournal } from '../dist/bridge-work-journal.js';
import { autoDistill } from '../dist/hooks/tool-execute-memory.js';
import { persistFinalDistillation } from '../dist/hooks/dispose-persistence.js';
import { initializeSqliteWorkJournal } from '../dist/schema/sqlite/work-journal.js';
import type {
  AgentBookCurrentState,
  AgentBookEvent,
  AgentBookRule,
  AgentBookSummary,
} from '../dist/agentbook-types.js';

const TEST_ROOT = resolve('.tmp', `privacy-persistence-${process.pid}-${Date.now()}`);
const WORKSPACE_ROOT = join(TEST_ROOT, 'workspace');
const SQLITE_PATH = join(TEST_ROOT, 'privacy.sqlite');
const PROJECT_ID = 'privacy-boundary-project';
const SESSION_ID = 'privacy-boundary-session';

// Assemble the fixture at runtime so repository secret scanners never need an exception.
const FAKE_SECRET = ['sk', 'proj', 'privacyboundary0123456789abcdef'].join('-');
const FAKE_SECRET_ALT = ['sk', 'proj', 'privacyboundaryfedcba9876543210'].join('-');

function assertSecretFree(value: unknown, label: string): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  assert.ok(!serialized.includes(FAKE_SECRET), `${label} retained the raw secret`);
  assert.ok(serialized.includes('[REDACTED_SECRET]'), `${label} omitted the redaction marker`);
}

describe('privacy persistence boundaries', () => {
  let database: Database;
  let redactor: Redactor;

  before(async () => {
    mkdirSync(WORKSPACE_ROOT, { recursive: true });
    database = new Database({
      databaseProvider: 'sqlite',
      sqlitePath: SQLITE_PATH,
    } as never);
    await database.connect();
    const pool = database.getPool();
    await pool.query(`
      CREATE TABLE context_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        display_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        message_index INTEGER,
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        tokens INTEGER,
        fetch_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE (session_id, display_id)
      )
    `);
    await initializeSqliteWorkJournal(pool);
    redactor = new Redactor({ workspaceRoot: WORKSPACE_ROOT });
  });

  after(async () => {
    await database.close();
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('redacts JSON values structurally without corrupting JSON serialization', () => {
    const original = {
      createdAt: new Date('2026-07-18T12:00:00.000Z'),
      nested: {
        token: FAKE_SECRET,
        url: `https://example.test/path?token=${FAKE_SECRET}`,
        omitted: undefined,
      },
      keyed: {
        [FAKE_SECRET]: 'first',
        [FAKE_SECRET_ALT]: 'second',
      },
    };

    const safe = redactJsonValue(redactor, original);
    const serialized = JSON.stringify(safe);
    assert.doesNotThrow(() => JSON.parse(serialized));
    assert.equal((safe as unknown as { createdAt: string }).createdAt, '2026-07-18T12:00:00.000Z');
    assertSecretFree(serialized, 'JSON-safe redaction');
    assert.ok(!serialized.includes(FAKE_SECRET_ALT));
    assert.deepEqual(Object.keys(safe.keyed), ['[REDACTED_SECRET]', '[REDACTED_SECRET]#2']);
    assert.deepEqual(Object.values(safe.keyed), ['first', 'second']);
  });

  it('redacts supported configured persistence boundaries and preserves operational identifiers', async () => {
    let stage = 'memory persistence';
    try {
    const pool = database.getPool();
    const memoryManager = new MemoryManager(
      database,
      { generate: async () => null } as never,
      redactor,
    );
    await memoryManager.createSession(SESSION_ID, PROJECT_ID);

    const saved = await memoryManager.saveMemory({
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      type: 'conversation',
      source: 'manual',
      content: `remember ${FAKE_SECRET}`,
      tags: [`credential:${FAKE_SECRET}`],
      metadata: { nested: { token: FAKE_SECRET } },
    });
    assert.equal(saved.projectId, PROJECT_ID);
    assertSecretFree(saved, 'memory result');

    await memoryManager.updateMemoryMetadata(saved.id, {
      [FAKE_SECRET]: `patched ${FAKE_SECRET}`,
      messageId: 'message-id-preserved',
    });
    await memoryManager.archiveSession(SESSION_ID, `archived with ${FAKE_SECRET}`);
    await memoryManager.emitEvent('privacy.test', {
      projectId: PROJECT_ID,
      [FAKE_SECRET]: `event ${FAKE_SECRET}`,
    }, SESSION_ID);
    await memoryManager.upsertProjectScope(
      PROJECT_ID,
      `project ${FAKE_SECRET}`,
      WORKSPACE_ROOT,
    );
    const updated = await memoryManager.getMemory(saved.id);
    const archived = await memoryManager.getSession(SESSION_ID);
    const projectScope = await memoryManager.getProjectScope(PROJECT_ID);
    assert.equal(updated?.metadata.messageId, 'message-id-preserved');
    assertSecretFree(updated?.metadata, 'updated memory metadata');
    assertSecretFree(archived?.summary, 'archived session summary');
    assert.equal(projectScope?.projectId, PROJECT_ID);
    assert.equal(projectScope?.directory, WORKSPACE_ROOT);
    assertSecretFree(projectScope?.name, 'project display name');

    const byRawQuery = await memoryManager.searchMemories({
      projectId: PROJECT_ID,
      searchMode: 'project',
      query: FAKE_SECRET,
      tags: [`credential:${FAKE_SECRET}`],
      limit: 10,
    });
    assert.ok(byRawQuery.some(({ memory }) => memory.id === saved.id),
      'raw caller query and tag must find redacted storage');
    const recallHash = await pool.query(
      `SELECT query_hash FROM memory_recall_events ORDER BY id DESC LIMIT 1`,
    );
    const storedQueryHash = String((recallHash.rows[0] as { query_hash: string }).query_hash);
    assert.equal(storedQueryHash, hashRecallQuery(redactor.redact(FAKE_SECRET).text));
    assert.notEqual(storedQueryHash, hashRecallQuery(FAKE_SECRET));
    const missingProjectScope = await memoryManager.searchMemories({
      searchMode: 'project',
      query: 'remember',
      limit: 10,
    });
    assert.deepEqual(missingProjectScope, [],
      'project mode without a project ID must fail closed');

    let byRawTag;
    try {
      byRawTag = await memoryManager.listMemories({
        projectId: PROJECT_ID,
        searchMode: 'project',
        tags: [`credential:${FAKE_SECRET}`],
        limit: 10,
      });
    } catch (error) {
      throw new Error(`raw tag compatibility lookup failed: ${(error as Error).message}`, {
        cause: error,
      });
    }
    assert.ok(byRawTag.some((memory) => memory.id === saved.id), 'raw caller tag must find redacted storage');

    stage = 'memory_save output';
    const saveDefinition = memorySaveTool(memoryManager, PROJECT_ID);
    const saveResult = await saveDefinition.execute(
      { content: `tool echo ${FAKE_SECRET}`, type: 'conversation' },
      { sessionID: undefined } as never,
    );
    assertSecretFree(saveResult, 'memory_save result');

    stage = 'context cache persistence';
    const filePath = join(WORKSPACE_ROOT, 'src', 'sensitive.ts');
    await storeItem(pool, {
      sessionId: SESSION_ID,
      displayId: 'file_redacted',
      kind: 'file_read',
      createdAt: Date.now(),
      summary: `read ${filePath}`,
      content: `file output ${FAKE_SECRET}`,
      metadata: { filePath, nested: { token: FAKE_SECRET } },
    }, redactor);
    await pool.query(
      `INSERT INTO context_cache
       (session_id, display_id, kind, created_at, summary, content, metadata)
       VALUES ($1, $2, 'file_read', $3, $4, $5, $6)`,
      [
        SESSION_ID,
        'file_legacy',
        Date.now() - 1,
        'legacy file read',
        'legacy content',
        JSON.stringify({ filePath }),
      ],
    );
    const reads = await fetchFileReads(pool, SESSION_ID, filePath, redactor);
    assert.deepEqual(
      new Set(reads.map((item) => item.displayId)),
      new Set(['file_redacted', 'file_legacy']),
      'digest-backed and legacy raw path rows must both remain retrievable',
    );
    const protectedFileRead = reads.find((item) => item.displayId === 'file_redacted');
    assert.ok(protectedFileRead, 'protected cache row must remain retrievable');
    assertSecretFree(protectedFileRead, 'protected cache row');

    const externalPathA = join(TEST_ROOT, 'external-a', 'secret.ts');
    const externalPathB = join(TEST_ROOT, 'external-b', 'secret.ts');
    await storeItem(pool, {
      sessionId: SESSION_ID,
      displayId: 'external_a',
      kind: 'file_read',
      createdAt: Date.now() + 1,
      summary: externalPathA,
      content: 'external A',
      metadata: { filePath: externalPathA },
    }, redactor);
    await storeItem(pool, {
      sessionId: SESSION_ID,
      displayId: 'external_b',
      kind: 'file_read',
      createdAt: Date.now() + 2,
      summary: externalPathB,
      content: 'external B',
      metadata: { filePath: externalPathB },
    }, redactor);
    const externalReadsA = await fetchFileReads(pool, SESSION_ID, externalPathA, redactor);
    const externalReadsB = await fetchFileReads(pool, SESSION_ID, externalPathB, redactor);
    assert.deepEqual(externalReadsA.map((item) => item.displayId), ['external_a']);
    assert.deepEqual(externalReadsB.map((item) => item.displayId), ['external_b']);
    assert.equal('_csmFilePathLookupV1' in (externalReadsA[0]?.metadata ?? {}), false,
      'internal lookup fingerprints must not be returned to callers');
    const externalRows = await pool.query(
      `SELECT metadata FROM context_cache WHERE display_id IN ('external_a', 'external_b')`,
    );
    const externalSerialized = JSON.stringify(externalRows.rows);
    assert.ok(!externalSerialized.includes(externalPathA));
    assert.ok(!externalSerialized.includes(externalPathB));

    const posixPathA = '/srv/CaseSensitive/secret.ts';
    const posixPathB = '/srv/casesensitive/secret.ts';
    const spacedWindowsPath = join(TEST_ROOT, 'External Customer', 'secret file.ts');
    const spacedPosixPath = '/Volumes/Customer Data/secret file.ts';
    const protectedComponentPathA = join(WORKSPACE_ROOT, 'users', 'alice@example.com', 'secret.ts');
    const protectedComponentPathB = join(WORKSPACE_ROOT, 'users', 'bob@example.com', 'secret.ts');
    for (const [displayId, cachedPath] of [
      ['posix_case_a', posixPathA],
      ['posix_case_b', posixPathB],
      ['spaced_windows', spacedWindowsPath],
      ['spaced_posix', spacedPosixPath],
      ['protected_component_a', protectedComponentPathA],
      ['protected_component_b', protectedComponentPathB],
    ] as const) {
      await storeItem(pool, {
        sessionId: SESSION_ID,
        displayId,
        kind: 'file_read',
        createdAt: Date.now() + 3,
        summary: cachedPath,
        content: displayId,
        metadata: { filePath: cachedPath },
      }, redactor);
    }
    assert.deepEqual(
      (await fetchFileReads(pool, SESSION_ID, posixPathA, redactor)).map((item) => item.displayId),
      ['posix_case_a'],
    );
    assert.deepEqual(
      (await fetchFileReads(pool, SESSION_ID, posixPathB, redactor)).map((item) => item.displayId),
      ['posix_case_b'],
    );
    assert.deepEqual(
      (await fetchFileReads(pool, SESSION_ID, spacedWindowsPath, redactor)).map((item) => item.displayId),
      ['spaced_windows'],
    );
    assert.deepEqual(
      (await fetchFileReads(pool, SESSION_ID, spacedPosixPath, redactor)).map((item) => item.displayId),
      ['spaced_posix'],
    );
    assert.deepEqual(
      (await fetchFileReads(pool, SESSION_ID, protectedComponentPathA, redactor))
        .map((item) => item.displayId),
      ['protected_component_a'],
    );
    assert.deepEqual(
      (await fetchFileReads(pool, SESSION_ID, protectedComponentPathB, redactor))
        .map((item) => item.displayId),
      ['protected_component_b'],
    );
    const spacedRows = await pool.query(
      `SELECT metadata FROM context_cache WHERE display_id IN ('spaced_windows', 'spaced_posix')`,
    );
    const spacedSerialized = JSON.stringify(spacedRows.rows);
    assert.ok(!spacedSerialized.includes(spacedWindowsPath));
    assert.ok(!spacedSerialized.includes(spacedPosixPath));

    stage = 'context cache error signal';
    await cacheToolErrorSignal(pool, {
      sessionId: SESSION_ID,
      toolName: 'shell',
      args: { command: `deploy --token ${FAKE_SECRET}` },
      output: `failure ${FAKE_SECRET}`,
      error: `authentication failed for ${FAKE_SECRET}`,
      exitCode: 1,
    });
    const cachedError = await fetchLastError(pool, SESSION_ID);
    assert.ok(cachedError, 'tool error signal must remain retrievable');
    assertSecretFree(cachedError, 'cached tool error');

    stage = 'experience packet persistence';
    const packets = new ExperiencePacketCreator(pool, redactor);
    const packet = await packets.recordToolPacket({
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      toolName: 'shell',
      args: { command: `deploy --token ${FAKE_SECRET}` },
      error: `failed ${FAKE_SECRET}`,
      signals: { nested: { token: FAKE_SECRET } },
    });
    assert.equal(packet.sessionId, SESSION_ID);
    assert.equal(packet.projectId, PROJECT_ID);
    assertSecretFree(packet, 'experience packet');

    stage = 'AgentBook persistence';
    const events = new AgentBookEventStore(pool, redactor);
    const rules = new AgentBookRulesStore(pool, redactor);
    const projector = new AgentBookStateProjector(pool, events, redactor);
    const summaries = new AgentBookSummaryGenerator(pool, events, redactor);
    const event = await events.append({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      eventType: 'blocker_identified',
      summary: `command exposed ${FAKE_SECRET}`,
      command: `deploy --token ${FAKE_SECRET}`,
      environment: { token: FAKE_SECRET },
      metadata: { error: FAKE_SECRET, callId: 'call-preserved' },
    });
    assert.equal(event.projectId, PROJECT_ID);
    assert.equal(event.sessionId, SESSION_ID);
    assert.equal(event.metadata.callId, 'call-preserved');
    assertSecretFree(event, 'AgentBook event');

    const rule = await rules.addRule({
      trigger: `when ${FAKE_SECRET} appears`,
      instruction: `never print ${FAKE_SECRET}`,
    });
    assertSecretFree(rule, 'AgentBook rule');
    const state = await projector.project(PROJECT_ID);
    const summary = await summaries.generate(PROJECT_ID, event.eventId, event.eventId);
    assertSecretFree(summary, 'AgentBook summary');
    const storedEvent = await pool.query(
      `SELECT * FROM agentbook_events WHERE event_id = $1`,
      [event.eventId],
    );
    const storedState = await pool.query(
      `SELECT * FROM agentbook_current_state WHERE project_id = $1`,
      [PROJECT_ID],
    );
    assert.equal(storedEvent.rows.length, 1);
    assert.equal(storedState.rows.length, 1);
    assertSecretFree(storedEvent.rows[0], 'stored AgentBook event');
    assertSecretFree(storedState.rows[0], 'stored AgentBook state');

    stage = 'bridge journal persistence';
    await writeBridgeTurnJournal(pool, {
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      role: 'user',
      content: `bridge input ${FAKE_SECRET}`,
      resultSummary: `bridge result ${FAKE_SECRET}`,
    }, redactor);
    const bridgeRows = await pool.query(
      `SELECT * FROM agent_work_journal WHERE session_id = $1 AND project_id = $2`,
      [SESSION_ID, PROJECT_ID],
    );
    assert.equal(bridgeRows.rows.length, 1);
    assertSecretFree(bridgeRows.rows[0], 'stored bridge journal entry');

    const protectedEventRows = await pool.query(
      `SELECT * FROM memory_events WHERE channel = 'privacy.test'`,
    );
    assert.equal(protectedEventRows.rows.length, 1);
    assertSecretFree(protectedEventRows.rows[0], 'stored memory event');

    stage = 'raw database inspection';
    const tables = [
      'sessions',
      'memories',
      'memory_events',
      'memory_recall_events',
      'project_scopes',
      'context_cache',
      'experience_packets',
      'agent_work_journal',
      'agentbook_events',
      'agentbook_rules',
      'agentbook_current_state',
      'agentbook_summaries',
    ];
    for (const table of tables) {
      const rows = await pool.query(`SELECT * FROM ${table}`);
      assert.ok(!JSON.stringify(rows.rows).includes(FAKE_SECRET), `${table} retained the raw secret`);
    }

    stage = 'AgentBook front page';
    const rawState: AgentBookCurrentState = {
      ...state,
      activeGoal: `remove ${FAKE_SECRET}`,
      blockers: [`blocked by ${FAKE_SECRET}`],
      nextSteps: [`rotate ${FAKE_SECRET}`],
    };
    const rawSummary: AgentBookSummary = {
      ...summary,
      summary: `summary ${FAKE_SECRET}`,
      failures: [`failure ${FAKE_SECRET}`],
    };
    const rawRule: AgentBookRule = {
      ...rule,
      trigger: `trigger ${FAKE_SECRET}`,
      instruction: `instruction ${FAKE_SECRET}`,
    };
    const rawEvent: AgentBookEvent = {
      ...event,
      summary: `event ${FAKE_SECRET}`,
      files: [`file-${FAKE_SECRET}`],
    };
    const frontPage = generateFrontPage(rawState, rawSummary, [rawRule], [rawEvent], redactor);
    assertSecretFree(frontPage.markdown, 'AgentBook front page');
    writeFrontPageFile(`legacy page ${FAKE_SECRET}`, WORKSPACE_ROOT, redactor);
    const written = readFileSync(join(WORKSPACE_ROOT, 'AGENTBOOK_STATE.md'), 'utf8');
    assertSecretFree(written, 'written AgentBook front page');
    } catch (error) {
      throw new Error(`${stage} failed: ${(error as Error).message}`, { cause: error });
    }
  });

  it('protects embedding-provider inputs and both legacy backfill paths', async () => {
    const providerInputs: string[] = [];
    const embeddings = {
      generate: async (content: string) => {
        providerInputs.push(content);
        return [0.125, 0.25];
      },
      getProviderInfo: () => ({ provider: 'test', model: 'privacy' }),
    };
    const fakePool = {
      query: async () => ({ rows: [], rowCount: 0 }),
    };
    const providerBoundaryManager = new MemoryManager({
      dialect: 'pg',
      getPool: () => fakePool,
    } as never, embeddings as never, redactor);
    await providerBoundaryManager.searchMemories({
      query: FAKE_SECRET,
      projectId: PROJECT_ID,
      searchMode: 'project',
      limit: 5,
    });
    assert.equal(providerInputs.length, 1);
    assertSecretFree(providerInputs[0], 'search embedding input');

    const pool = database.getPool();
    const managerProject = 'privacy-backfill-manager';
    const standaloneProject = 'privacy-backfill-standalone';
    const managerInsert = await pool.query(
      `INSERT INTO memories (project_id, memory_type, content)
       VALUES ($1, 'conversation', $2) RETURNING id`,
      [managerProject, `legacy manager ${FAKE_SECRET}`],
    );
    const standaloneInsert = await pool.query(
      `INSERT INTO memories (project_id, memory_type, content)
       VALUES ($1, 'conversation', $2) RETURNING id`,
      [standaloneProject, `legacy standalone ${FAKE_SECRET}`],
    );

    const manager = new MemoryManager(database, embeddings as never, redactor);
    const managerResult = await manager.backfillMissingEmbeddings({
      projectId: managerProject,
      limit: 1,
    });
    assert.equal(managerResult.updated, 1);

    const standalone = new EmbeddingBackfill(database, embeddings as never, redactor);
    const standaloneResult = await standalone.backfill({
      projectId: standaloneProject,
      batchSize: 1,
      maxTotal: 1,
      batchDelayMs: 0,
    });
    assert.equal(standaloneResult.succeeded, 1);

    for (const input of providerInputs.slice(1)) {
      assertSecretFree(input, 'backfill embedding input');
    }
    const chunkRows = await pool.query(
      `SELECT memory_id, content FROM memory_chunks WHERE memory_id IN ($1, $2) ORDER BY memory_id`,
      [
        (managerInsert.rows[0] as { id: number }).id,
        (standaloneInsert.rows[0] as { id: number }).id,
      ],
    );
    assert.equal(chunkRows.rows.length, 2);
    assertSecretFree(chunkRows.rows, 'backfilled memory chunks');
    const legacyRows = await pool.query(
      `SELECT content FROM memories WHERE id IN ($1, $2) ORDER BY id`,
      [
        (managerInsert.rows[0] as { id: number }).id,
        (standaloneInsert.rows[0] as { id: number }).id,
      ],
    );
    assert.ok(JSON.stringify(legacyRows.rows).includes(FAKE_SECRET),
      'backfill must not silently rewrite legacy source rows');
  });

  it('redacts manual, automatic, and shutdown distillation before persistence', async () => {
    const inserted: unknown[][] = [];
    const safeSummaries: unknown[] = [];
    const summary = {
      id: 'distill-privacy',
      groups: [{
        id: 'group-privacy',
        intent: `authenticate ${FAKE_SECRET}`,
        toolCalls: [],
        filesChanged: [],
        commandsRun: [`deploy ${FAKE_SECRET}`],
        outcome: 'failure',
        errorSummary: `failure ${FAKE_SECRET}`,
        fixApplied: null,
        proceduralInsight: `rotate ${FAKE_SECRET}`,
      }],
      compressed: `distilled ${FAKE_SECRET}`,
      totalCallsSummarized: 2,
      createdAt: new Date(),
    };
    const context = {
      toolDistiller: { distill: () => summary },
      database: {
        getPool: () => ({
          query: async (_sql: string, params: unknown[]) => {
            inserted.push(params);
            return { rows: [], rowCount: 0 };
          },
        }),
      },
      redactor,
      config: { distiller: { autoSaveAsMemory: true } },
      memoryExtractor: {
        extractFromDistilledSummaries: async (_session: string, _project: string, safe: unknown) => {
          safeSummaries.push(safe);
          return [];
        },
      },
      experiencePackets: {
        recordDistillGroupPacket: async (safe: unknown) => {
          safeSummaries.push(safe);
          return safe;
        },
      },
      refreshActiveContext: async () => undefined,
    };

    const manualParams: unknown[][] = [];
    const manualDownstream: unknown[] = [];
    const manualTool = memoryDistillTool(
      { distill: () => summary } as never,
      {
        getPool: () => ({
          query: async (_sql: string, params: unknown[]) => {
            manualParams.push(params);
            return { rows: [], rowCount: 0 };
          },
        }),
      } as never,
      {
        extractFromDistilledSummaries: async (_session: string, _project: string, safe: unknown) => {
          manualDownstream.push(safe);
          return [];
        },
      } as never,
      PROJECT_ID,
      redactor,
    );
    const manualResult = await manualTool.execute(
      {},
      { sessionID: SESSION_ID } as never,
    );
    assertSecretFree(manualParams, 'manual distilled storage');
    assertSecretFree(manualDownstream, 'manual distilled downstream payload');
    assertSecretFree(manualResult, 'manual distilled result');

    const shutdownParams: unknown[][] = [];
    await persistFinalDistillation({
      config: { distiller: { enabled: true } },
      database: {
        getPool: () => ({
          query: async (_sql: string, params: unknown[]) => {
            shutdownParams.push(params);
            return { rows: [], rowCount: 0 };
          },
        }),
      },
      toolDistiller: { distill: () => summary },
      redactor,
      state: { currentSessionId: SESSION_ID },
    } as never);
    assertSecretFree(shutdownParams, 'shutdown distilled storage');

    await autoDistill(context as never, SESSION_ID);
    assertSecretFree(inserted, 'automatic distilled storage');
    assertSecretFree(safeSummaries, 'automatic distillation downstream payload');
  });

  it('honors an explicit redaction opt-out instead of silently overriding buyer configuration', async () => {
    let inserted: unknown[] = [];
    const pool = {
      query: async (_sql: string, params: unknown[]) => {
        inserted = params;
        return { rows: [], rowCount: 0 };
      },
    };
    await storeItem(pool as never, {
      sessionId: 'disabled-session',
      displayId: 'disabled-item',
      kind: 'turn',
      createdAt: Date.now(),
      summary: FAKE_SECRET,
      content: FAKE_SECRET,
      metadata: { token: FAKE_SECRET },
    }, new Redactor({ enabled: false }));
    assert.ok(JSON.stringify(inserted).includes(FAKE_SECRET));
  });
});

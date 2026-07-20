import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { CodexMemoryBridge } from '../dist/codex-bridge.js';
import { CheckpointStore } from '../src/checkpoint-store.js';
import { storeItem } from '../src/context-cache-store.js';
import { FailureTraceStore } from '../src/failure-trace-store.js';
import { setActiveGoal } from '../src/goal-schema.js';
import type { PluginConfig } from '../dist/types.js';

const BASE_DB_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/cross_session_memory';

function buildUrl(dbUrl: string, dbName: string): string {
  const url = new URL(dbUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function adminUrl(dbUrl: string): string { const url = new URL(dbUrl); url.pathname = '/postgres'; return url.toString(); }
function quote(name: string): string { return `"${name.replace(/"/g, '""')}"`; }
function bridgeSessionId(projectRoot: string): string { return `codex-${createHash('sha1').update(projectRoot).digest('hex').slice(0, 12)}`; }

describe('Codex bridge workflow tools', () => {
  const dbName = `cross_session_memory_codex_workflow_${Date.now()}`;
  const databaseUrl = buildUrl(BASE_DB_URL, dbName);
  const adminPool = new Pool({ connectionString: adminUrl(BASE_DB_URL) });
  const projectPool = new Pool({ connectionString: databaseUrl });
  const config: PluginConfig = { databaseUrl, embeddingModel: 'nomic-embed-text', embeddingApiUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434' } as PluginConfig;

  let bridge: CodexMemoryBridge;

  before(async () => {
    adminPool.on('error', () => {});
    projectPool.on('error', () => {});
    await adminPool.query(`CREATE DATABASE ${quote(dbName)}`);
    bridge = await CodexMemoryBridge.connect(config);
  });

  after(async () => {
    await bridge.disconnect();
    await projectPool.end();
    await adminPool.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1
         AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await adminPool.query(`DROP DATABASE ${quote(dbName)}`);
    await adminPool.end();
  });

  it('resumes context with recent memory and lesson recall', async () => {
    const sessionId = bridgeSessionId('workflow-project');
    await setActiveGoal(projectPool as any, sessionId, 'Continue the richer continuity packet');
    await projectPool.query(
      `INSERT INTO agent_work_journal
       (session_id, project_id, entry_type, tool_name, intent, result_summary, error_summary, files_touched)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        'prior-session',
        'workflow-project',
        'error',
        'bash',
        'Run workflow verification against the bridge.',
        'Verification failed on provenance ranking.',
        'Missing direct provenance label in resume context.',
        ['src/codex-bridge-workflow.ts', 'test/codex-bridge-workflow.test.ts'],
      ],
    );
    await new CheckpointStore(projectPool as any).createCheckpoint({
      sessionId,
      projectId: 'workflow-project',
      summaryMarkdown: 'Checkpoint summary for workflow recovery. Resume from the cached bridge state before new edits.',
      summaryTokens: 24,
      inputTokensEstimate: 60,
      sourceRefs: [{ messageId: 'msg-bridge-1', role: 'assistant', kind: 'assistant_text', note: 'Last assistant checkpoint brief.' }],
      compactedRefs: [],
      filesMentioned: ['src/codex-bridge-workflow.ts'],
      testsMentioned: ['test/codex-bridge-workflow.test.ts'],
      risks: ['Resume packets can omit the last failure context.'],
      nextSteps: ['Thread checkpoint and cache state into the bridge resume payload.'],
      rawCaptures: [],
    });
    await storeItem(projectPool as any, {
      sessionId,
      displayId: 'bridge-decision-1',
      kind: 'decision',
      createdAt: Date.now(),
      summary: 'Use checkpoint and cache recovery state in bridge resumes.',
      content: 'Decision: recovery payloads should expose checkpoint, last error, and recent decisions.',
    });
    await storeItem(projectPool as any, {
      sessionId,
      displayId: 'bridge-error-1',
      kind: 'error',
      createdAt: Date.now() + 1,
      summary: 'Bridge resume packet still missed the latest cached error.',
      content: 'Resume packet omitted the cached error summary needed for handoff recovery.',
    });
    await bridge.saveMemory({
      projectRoot: 'workflow-project',
      content: 'Remember to check the bridge event stream before handoff.',
      type: 'lesson',
      tags: ['bridge'],
      metadata: {
        source_kind: 'summary',
        evidence_strength: 'direct_summary',
      },
    });
    await bridge.saveMemory({
      projectRoot: 'workflow-project',
      content: 'Keep raw command output attached to verification claims.',
      type: 'lesson',
      tags: ['verification'],
      metadata: {
        source_kind: 'transcript',
        evidence_strength: 'direct_original',
      },
    });
    const resumed = await bridge.resumeContext({
      projectRoot: 'workflow-project',
      task: 'resume bridge workflow',
      recentLimit: 3,
    });
    assert.equal(resumed.sessionId.startsWith('codex-'), true);
    assert.equal(Array.isArray(resumed.recent), true);
    assert.ok(resumed.lessons[0]?.content.includes('raw command output'));
    assert.equal(resumed.workJournal?.sourceSessionId, 'prior-session');
    assert.match(resumed.workJournal?.nextStepInferred ?? '', /Fix error|Missing direct provenance/);
    assert.equal(resumed.provenance.governanceEligibleCount, 0);
    assert.equal(resumed.provenance.contextOnlyCount >= 1, true);
    assert.match(resumed.sessionState?.activeGoal?.description ?? '', /richer continuity packet/);
    assert.match(resumed.recovery?.activeCheckpoint?.summaryExcerpt ?? '', /workflow recovery/);
    assert.match(resumed.recovery?.lastError?.summary ?? '', /latest cached error/);
    assert.equal(resumed.recovery?.lastError?.fetchAction.tool, 'context_fetch');
    assert.match(resumed.recovery?.recentDecisions[0]?.summary ?? '', /checkpoint and cache recovery state/);
    assert.equal(resumed.recovery?.activeCheckpoint?.expandableRefs[0]?.expandAction.tool, 'expand_checkpoint_ref');
    assert.equal(resumed.recovery?.activeCheckpoint?.expandableRefs[0]?.expandAction.args.refId, 'msg-bridge-1');
    assert.equal(resumed.recovery?.activeCheckpoint?.reviewAction.tool, 'list_checkpoints');
    assert.equal(resumed.actionPlan[0]?.tool, 'expand_checkpoint_ref');
    assert.equal(resumed.actionPlan[1]?.tool, 'context_fetch');
    assert.deepEqual(resumed.actionPlan.map((item) => item.priority), [1, 1, 2, 2, 3]);
    const resumedAgain = await bridge.resumeContext({ projectRoot: 'workflow-project', task: 'resume bridge workflow again' });
    assert.match(resumedAgain.recovery?.lastResume?.summary ?? '', /resume bridge workflow/);
    assert.match(resumedAgain.recovery?.matchingWorkflow?.summary ?? '', /resume bridge workflow/);
  });

  it('syncs a turn into memory, provenance metadata, and the work journal', async () => {
    const synced = await bridge.syncTurn({
      projectRoot: 'workflow-project',
      role: 'assistant',
      content: 'We added the repo-local marketplace wrapper.',
      tags: ['handoff'],
    });
    assert.equal(synced.channel, 'codex_bridge.turn_synced');
    assert.match(synced.memory.content, /\[assistant\]/);
    assert.equal(synced.memory.metadata.source_kind, 'transcript');
    assert.equal(synced.memory.metadata.evidence_strength, 'direct_original');
    const journal = await projectPool.query(
      `SELECT tool_name, intent, result_summary
       FROM agent_work_journal
       WHERE session_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [synced.sessionId],
    );
    assert.equal(journal.rows.length, 1);
    assert.equal((journal.rows[0] as { tool_name: string }).tool_name, 'bridge_sync_turn');
    assert.match((journal.rows[0] as { result_summary: string }).result_summary, /Synced bridge turn/);
  });

  it('builds a handoff summary with compaction status', async () => {
    const store = new FailureTraceStore(projectPool as any);
    await store.initialize();
    await store.store({
      problem: 'Bridge handoff omitted the last failing step.',
      attemptedAction: 'Tried to resume from memories alone.',
      result: 'failed',
      correction: 'Include work journal and failure trace context in the handoff packet.',
      lessonCreated: 'Use richer continuity packets for resumptions.',
      evidenceAnchors: ['test/codex-bridge-workflow.test.ts'],
      createdBySession: bridgeSessionId('workflow-project'),
      relatedTraceIds: [],
    });
    const handoff = await bridge.getHandoffSummary({
      projectRoot: 'workflow-project',
      task: 'continue plugin install work',
    });

    assert.equal(handoff.sessionId.startsWith('codex-'), true);
    assert.match(handoff.summary, /Project task: continue plugin install work/);
    assert.match(handoff.summary, /Recent memory:/);
    assert.match(handoff.summary, /Active goal:/);
    assert.match(handoff.summary, /Latest failure:/);
    assert.match(handoff.summary, /Active checkpoint:/);
    assert.match(handoff.summary, /Cached error:/);
    assert.match(handoff.summary, /Recent decisions:/);
    assert.match(handoff.summary, /Recovery refs:/);
    assert.match(handoff.summary, /Suggested actions:/);
    assert.match(handoff.summary, /Recent steps:/);
    assert.match(handoff.summary, /Provenance:/);
    assert.equal(handoff.context.recovery?.activeCheckpoint?.expandableRefs[0]?.expandAction.tool, 'expand_checkpoint_ref');
    assert.equal(handoff.context.recovery?.activeCheckpoint?.expandableRefs[0]?.expandAction.args.refId, 'msg-bridge-1');
    assert.equal(handoff.context.actionPlan[0]?.tool, 'expand_checkpoint_ref');
    const cachedHandoff = await projectPool.query(`SELECT summary FROM context_cache WHERE session_id = $1 AND metadata->>'source' = 'bridge_handoff_summary' ORDER BY created_at DESC LIMIT 1`, [handoff.sessionId]);
    assert.match((cachedHandoff.rows[0] as { summary: string }).summary, /continue plugin install work/);
    const resumed = await bridge.resumeContext({ projectRoot: 'workflow-project', task: 'resume after handoff' });
    assert.match(resumed.recovery?.lastHandoff?.summary ?? '', /continue plugin install work/);
    assert.match(resumed.recovery?.lastResume?.summary ?? '', /resume bridge workflow again|resume bridge workflow/);
  });
});

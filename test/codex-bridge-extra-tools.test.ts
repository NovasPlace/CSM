import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { CodexMemoryBridge } from '../dist/codex-bridge.js';
import { MCP_TOOLS, invokeMcpTool } from '../dist/codex-mcp-tools.js';
import type { PluginConfig } from '../dist/types.js';

const BASE_DB_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/cross_session_memory';

function buildUrl(dbUrl: string, dbName: string): string {
  const url = new URL(dbUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function adminUrl(dbUrl: string): string {
  const url = new URL(dbUrl);
  url.pathname = '/postgres';
  return url.toString();
}

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

describe('Codex bridge extra plugin surfaces', () => {
  const dbName = `cross_session_memory_codex_extras_${Date.now()}`;
  const databaseUrl = buildUrl(BASE_DB_URL, dbName);
  const adminPool = new Pool({ connectionString: adminUrl(BASE_DB_URL) });
  const config: PluginConfig = {
    databaseUrl,
    embeddingModel: 'nomic-embed-text',
    embeddingApiUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434',
  } as PluginConfig;

  let bridge: CodexMemoryBridge;

  before(async () => {
    await adminPool.query(`CREATE DATABASE ${quote(dbName)}`);
    bridge = await CodexMemoryBridge.connect(config);
  });

  after(async () => {
    await bridge.disconnect();
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

  it('routes goal, cache, checkpoint, and runtime tools through the MCP bridge', async () => {
    assert.equal(MCP_TOOLS.some((tool) => tool.name === 'goal_set'), true);
    assert.equal(MCP_TOOLS.some((tool) => tool.name === 'context_fetch'), true);
    assert.equal(MCP_TOOLS.some((tool) => tool.name === 'memory_lesson'), true);
    assert.equal(MCP_TOOLS.some((tool) => tool.name === 'create_checkpoint'), true);
    assert.equal(MCP_TOOLS.some((tool) => tool.name === 'csm_context_pressure'), true);
    assert.equal(MCP_TOOLS.some((tool) => tool.name === 'csm_context_budget'), true);
    const deleteSpec = MCP_TOOLS.find((tool) => tool.name === 'memory_delete');
    assert.ok(deleteSpec?.inputSchema.required.includes('projectRoot'));
    const searchSpec = MCP_TOOLS.find((tool) => tool.name === 'search_memories');
    assert.ok(searchSpec?.inputSchema.required.includes('projectId'));
    assert.equal('searchMode' in searchSpec!.inputSchema.properties, false);
    const cleanupSpec = MCP_TOOLS.find((tool) => tool.name === 'memory_cleanup');
    assert.ok(cleanupSpec?.inputSchema.required.includes('projectRoot'));
    assert.ok('apply' in cleanupSpec!.inputSchema.properties);
    const transcriptSpec = MCP_TOOLS.find((tool) => tool.name === 'memory_transcript');
    assert.ok(transcriptSpec?.inputSchema.required.includes('projectRoot'));

    await bridge.saveMemory({
      projectRoot: 'extras-project',
      content: 'Bridge extras need a visible project scope.',
      type: 'workspace',
    });
    await bridge.saveMemory({
      projectRoot: 'foreign-extras-project',
      sessionId: 'foreign-extras-session',
      content: 'A different project must not appear in customer-facing MCP list results.',
      type: 'conversation',
    });
    await assert.rejects(
      () => invokeMcpTool(bridge, 'memory_transcript', {
        projectRoot: 'extras-project',
        sessionId: 'foreign-extras-session',
      }),
      /belongs to a different project/,
    );

    const scopedList = await invokeMcpTool(bridge, 'list_memories', {
      projectId: 'extras-project',
      searchMode: 'global',
      limit: 20,
    }) as Array<{ projectId?: string }>;
    assert.ok(scopedList.length >= 1);
    assert.ok(scopedList.every((memory) => memory.projectId === 'extras-project'));
    await assert.rejects(
      () => invokeMcpTool(bridge, 'search_memories', { query: 'different project' }),
      /projectId must be a non-empty string/,
    );

    const goal = await invokeMcpTool(bridge, 'goal_set', {
      projectRoot: 'extras-project',
      description: 'Expose the remaining plugin surfaces through Codex',
    });
    assert.equal((goal as { status?: string }).status, 'active');

    const goals = await invokeMcpTool(bridge, 'goal_list', { projectRoot: 'extras-project' });
    assert.equal(Array.isArray((goals as { goals?: unknown[] }).goals), true);
    assert.ok(((goals as { goals?: unknown[] }).goals ?? []).length >= 1);

    const projects = await invokeMcpTool(bridge, 'memory_project_list', {});
    assert.ok(((projects as { projects?: Array<{ directory?: string }> }).projects ?? []).some((project) => project.directory === 'extras-project'));

    const checkpointList = await invokeMcpTool(bridge, 'list_checkpoints', { projectRoot: 'extras-project' });
    assert.equal(Array.isArray((checkpointList as { checkpoints?: unknown[] }).checkpoints), true);

    const cacheHit = await invokeMcpTool(bridge, 'context_fetch', { projectRoot: 'extras-project', id: 'missing-item' });
    assert.equal((cacheHit as { item?: unknown }).item ?? null, null);

    const lesson = await invokeMcpTool(bridge, 'memory_lesson', {
      projectRoot: 'extras-project',
      content: 'Always expose bridge-only admin tools through MCP.',
      tags: ['bridge', 'lesson'],
    });
    assert.ok((lesson as { memory?: { id?: number } }).memory?.id);

    const deleted = await invokeMcpTool(bridge, 'memory_delete', {
      projectRoot: 'extras-project',
      id: (lesson as { memory?: { id?: number } }).memory?.id,
    });
    assert.equal((deleted as { deleted?: boolean }).deleted, true);
    await assert.rejects(
      () => invokeMcpTool(bridge, 'memory_delete', {
        id: (lesson as { memory?: { id?: number } }).memory?.id,
      }),
      /projectRoot must be a non-empty string/,
    );

    const cleanupPreview = await invokeMcpTool(bridge, 'memory_cleanup', {
      projectRoot: 'extras-project',
    }) as { dryRun?: boolean; projectId?: string; deleted?: number };
    assert.equal(cleanupPreview.dryRun, true);
    assert.equal(cleanupPreview.projectId, 'extras-project');
    assert.equal(cleanupPreview.deleted, 0);
    await assert.rejects(
      () => invokeMcpTool(bridge, 'memory_cleanup', {}),
      /projectRoot must be a non-empty string/,
    );

    const distilled = await invokeMcpTool(bridge, 'memory_distilled_view', { projectRoot: 'extras-project', limit: 1 });
    assert.equal(Array.isArray((distilled as { summaries?: unknown[] }).summaries), true);

    const compact = await invokeMcpTool(bridge, 'memory_compact', {});
    assert.ok((compact as { cumulative?: unknown }).cumulative);

    const review = await invokeMcpTool(bridge, 'context_review', { projectRoot: 'extras-project', detail: 'summary' });
    assert.ok((review as { available?: boolean }).available === false || (review as { available?: boolean }).available === true);

    const checkpoint = await invokeMcpTool(bridge, 'create_checkpoint', {
      projectRoot: 'extras-project',
      messages: [
        { info: { id: 'msg-1', role: 'user' }, parts: [{ type: 'text', text: 'Need to verify the bridge extras.' }] },
        { info: { id: 'msg-2', role: 'assistant' }, parts: [{ type: 'text', text: 'We added goal, cache, checkpoint, and runtime exposure.' }] },
      ],
    });
    assert.equal((checkpoint as { created?: boolean }).created, true);

    const distill = await invokeMcpTool(bridge, 'memory_distill', {
      projectRoot: 'extras-project',
      calls: [
        {
          tool: 'edit',
          args: { filePath: 'src/example.ts' },
          output: 'patched the bridge helper',
          timestamp: Date.now() - 20,
          sessionId: 'extras-session',
          filePath: 'src/example.ts',
        },
        {
          tool: 'edit',
          args: { filePath: 'src/example.ts' },
          output: 'patched the bridge helper again',
          timestamp: Date.now(),
          sessionId: 'extras-session',
          filePath: 'src/example.ts',
        },
      ],
    });
    assert.ok((distill as { summary?: { groups?: unknown[] } }).summary?.groups?.length);

    const runtime = await invokeMcpTool(bridge, 'csm_runtime_status', {});
    assert.equal((runtime as { plugin_loaded?: boolean }).plugin_loaded, true);

    const pressure = await invokeMcpTool(bridge, 'csm_context_pressure', {
      maxTokens: 10000,
      nextTurnTokens: 500,
      messages: [
        { role: 'user', content: 'Please expose the window as a real tool.' },
        { role: 'assistant', content: 'We should make the context budget visible.' },
      ],
    });
    assert.equal((pressure as { messageCount?: number }).messageCount, 2);
    assert.equal((pressure as { maxTokens?: number }).maxTokens, 10000);
    assert.equal((pressure as { projectedNextTurnTokens?: number }).projectedNextTurnTokens, ((pressure as { estimatedTokens?: number }).estimatedTokens ?? 0) + 500);

    const budget = await invokeMcpTool(bridge, 'csm_context_budget', {
      latestUserText: 'run tests and keep only the important proof',
      touchedFiles: ['src/context-budget-governor.ts'],
      command: 'npm test',
      stdout: Array.from({ length: 60 }, (_, index) => `pass ${index}`).join('\n'),
      exitCode: 0,
    });
    assert.equal((budget as { decision?: { toolOutputMode?: string } }).decision?.toolOutputMode, 'distilled');
    assert.equal((budget as { decision?: { ruleMode?: string } }).decision?.ruleMode, 'load_triggered_rules');
    assert.equal(typeof (budget as { promptPayload?: unknown }).promptPayload, 'string');
    assert.equal(typeof (budget as { evidenceRef?: unknown }).evidenceRef, 'string');
  });
});

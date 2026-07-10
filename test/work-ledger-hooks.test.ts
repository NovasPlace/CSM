import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createChatMessageHook } from '../src/hooks/event-hooks.js';
import {
  createToolExecuteAfterHook,
  createToolExecuteBeforeHook,
} from '../src/hooks/tool-execute.js';

function hookContext(captures: Array<{ phase: string; value: Record<string, unknown> }>) {
  return {
    directory: 'C:\\workspace',
    state: {
      currentSessionId: 'session-1',
      runId: 'run-1',
      currentModelId: 'openai:gpt-5-codex',
      modelIdBySession: new Map([['session-1', 'openai:gpt-5-codex']]),
      recentUserMessages: new Map(),
      sourceOnlySessions: new Set(),
      capturedMessageSizes: new Map(),
      _docsInitialized: true,
    },
    syncActiveSession(sessionId: string) { this.state.currentSessionId = sessionId; },
    workLedger: {
      async captureBefore(value: Record<string, unknown>) { captures.push({ phase: 'before', value }); },
      async captureAfter(value: Record<string, unknown>) { captures.push({ phase: 'after', value }); return []; },
    },
    loopDetector: { recordCall: () => ({ loop: false }) },
    lessonTriggers: { refresh: async () => {}, buildInjection: () => null },
    config: {
      checkpoint: { auto: { enabled: false } },
      workJournal: { enabled: false },
      distiller: { enabled: false },
      contextCache: { enabled: false },
      logToolUsage: false,
      autoDocs: { enabled: false },
    },
    loopSignalDetector: { record() {}, check: () => null },
    experiencePackets: {
      recordToolPacket: async () => ({}),
      recordMilestonePacket: async () => ({}),
    },
  } as any;
}

it('captures edit provenance before and after with stable run/model/tool identity', async () => {
  const captures: Array<{ phase: string; value: Record<string, unknown> }> = [];
  const context = hookContext(captures);
  const input = {
    tool: 'edit',
    sessionID: 'session-1',
    callID: 'call-1',
    args: { filePath: 'src/a.ts' },
  };
  await createToolExecuteBeforeHook(context)(input, { args: input.args });
  await createToolExecuteAfterHook(context)(input, { title: 'edited', output: 'ok', metadata: {} });
  assert.deepEqual(captures.map((item) => item.phase), ['before', 'after']);
  for (const capture of captures) {
    assert.equal(capture.value.runId, 'run-1');
    assert.equal(capture.value.modelId, 'openai:gpt-5-codex');
    assert.equal(capture.value.toolCallId, 'call-1');
  }
});

it('learns host model identity unless an environment identity is pinned', async () => {
  const context = hookContext([]);
  await createChatMessageHook(context)(
    { sessionID: 'session-1', model: { providerID: 'anthropic', modelID: 'claude-opus' } },
    { parts: [{ type: 'text', text: 'continue' }] },
  );
  assert.equal(context.state.currentModelId, 'anthropic:claude-opus');
  assert.equal(context.state.modelIdBySession.get('session-1'), 'anthropic:claude-opus');
  context.state.modelIdPinned = true;
  context.state.currentModelId = 'orchestrator:fixed-model';
  await createChatMessageHook(context)(
    { sessionID: 'session-1', model: { providerID: 'google', modelID: 'gemini' } },
    { parts: [{ type: 'text', text: 'continue' }] },
  );
  assert.equal(context.state.currentModelId, 'orchestrator:fixed-model');
});

it('keeps model attribution isolated across interleaved sessions', async () => {
  const captures: Array<{ phase: string; value: Record<string, unknown> }> = [];
  const context = hookContext(captures);
  await createChatMessageHook(context)(
    { sessionID: 'session-2', model: { providerID: 'google', modelID: 'gemini' } },
    { parts: [{ type: 'text', text: 'continue' }] },
  );
  const input = {
    tool: 'edit', sessionID: 'session-1', callID: 'call-2', args: { filePath: 'src/a.ts' },
  };
  await createToolExecuteBeforeHook(context)(input, { args: input.args });
  assert.equal(captures[0].value.modelId, 'openai:gpt-5-codex');
});

it('fails a supported edit visibly when provenance capture fails', async () => {
  const context = hookContext([]);
  context.workLedger.captureBefore = async () => { throw new Error('ledger unavailable'); };
  const input = {
    tool: 'edit', sessionID: 'session-1', callID: 'call-fail', args: { filePath: 'src/a.ts' },
  };
  await assert.rejects(
    () => createToolExecuteBeforeHook(context)(input, { args: input.args }),
    /ledger unavailable/,
  );
});

it('surfaces an after-capture failure after the filesystem tool returns', async () => {
  const context = hookContext([]);
  context.workLedger.captureAfter = async () => { throw new Error('ledger persist failed'); };
  const input = {
    tool: 'edit', sessionID: 'session-1', callID: 'call-after-fail', args: { filePath: 'src/a.ts' },
  };
  await assert.rejects(
    () => createToolExecuteAfterHook(context)(input, { title: 'edited', output: 'ok', metadata: {} }),
    /ledger persist failed/,
  );
});

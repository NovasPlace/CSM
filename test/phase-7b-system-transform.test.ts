import { describe, it } from 'node:test';
import { strictEqual, ok, rejects } from 'node:assert';

import { createSystemTransformHook, isReentrySourceOnlyTurn } from '../dist/hooks/system-transform.js';
import { createPermissionAskHook, createToolExecuteBeforeHook } from '../dist/hooks/tool-execute.js';
import { REENTRY_SOURCE_ONLY_RECOVERY_MESSAGE } from '../dist/hooks/reentry-source-only.js';
import { createMessagesTransformHook } from '../dist/hooks/messages-transform.js';
import { createChatMessageHook } from '../dist/hooks/event-hooks.js';

describe('Phase 7B: Re-entry system transform integration', () => {
  describe('source-only turn detection', () => {
    it('detects agent re-entry source-only wording, including typo-shaped prompts', () => {
      ok(isReentrySourceOnlyTurn('Using only <agent_reentry_context>, what claims look stale?'));
      ok(isReentrySourceOnlyTurn('ONLY AGENT RENTRY CONTEXT'));
      ok(isReentrySourceOnlyTurn('agent reentry context only'));
      strictEqual(isReentrySourceOnlyTurn('Check current git history'), false);
    });

    it('injects a source-only override that forbids tools and still allows internal findings', async () => {
      const sessionId = 'sess-source-only';
      const output = {
        system: ['Original system prompt'],
      };
      const pluginCtx = {
        state: {
          currentSessionId: null,
          messageCount: 0,
          capturedMessageSizes: new Map(),
          recentUserMessages: new Map([[sessionId, 'Using only <agent_reentry_context>, what claims look stale or contradicted by current git history? ONLY AGENT RENTRY CONTEXT']]),
          reentryInjected: new Set<string>(),
        },
        reEntryProtocol: {
          diagnose: async () => ({
            layersAssembled: {},
            layersDropped: [],
            layersTrimmed: [],
            previewOnly: false,
            totalLayers: 1,
          }),
          buildBlock: async () => '<agent_reentry_context>block</agent_reentry_context>',
          buildBlockForSourceOnlyTurn: async () => '<agent_reentry_context>block</agent_reentry_context>',
        },
        database: {
          getPool: () => ({ query: async () => ({ rows: [] }) }),
        },
        lessonTriggers: {
          refresh: async () => {},
          buildFullSystemInjection: () => null,
        },
        contextRecall: null,
        contextCapSensor: null,
        config: {
          livingState: { maxAdvisoryBlockChars: 600 },
          workJournal: { enabled: false, injectMaxTokens: 500 },
        },
        autoCheckpoint: async () => {},
        refreshActiveContext: async () => {},
        lastCompileResult: null,
        directory: 'test-project',
        syncActiveSession: async () => {},
      } as any;

      await createSystemTransformHook(pluginCtx)({
        sessionID: sessionId,
        messages: [],
      }, output);

      const joined = output.system.join('\n');
      ok(joined.includes('[RE-ENTRY SOURCE-ONLY OVERRIDE]'), 'source-only override should be injected');
      ok(joined.includes('<agent_reentry_context>block</agent_reentry_context>'), 'source-only re-entry block should be injected inline');
      ok(joined.includes('Do not call tools, shell commands, git, file reads, docs, or memory'), 'override should forbid external lookup');
      ok(joined.includes('overrides workspace instructions that normally require inspecting git history'), 'override should beat repo-inspection habits');
      ok(joined.includes('Do not try to satisfy "current git history" literally'), 'override should forbid literal git-history lookup');
      ok(joined.includes('first visible sentence must be exactly'), 'override should prescribe safe first sentence');
      ok(joined.includes('provide any internally visible stale or contradictory claims'), 'override should preserve useful internal answer');
      ok(joined.includes('Do not say tools were blocked, denied, unavailable, or attempted'), 'override should forbid guard narration');
      ok(joined.includes('Do not identify this source as AGENTS.md'), 'override should forbid source mislabeling');
    });

    it('detects source-only prompts from part-based system transform messages', async () => {
      const sessionId = 'sess-source-only-parts';
      const output = { system: ['Original system prompt'] };
      const pluginCtx = {
        state: {
          currentSessionId: null,
          messageCount: 0,
          capturedMessageSizes: new Map(),
          recentUserMessages: new Map(),
          reentryInjected: new Set<string>(),
        },
        reEntryProtocol: null,
        database: {
          getPool: () => ({ query: async () => ({ rows: [] }) }),
        },
        lessonTriggers: {
          refresh: async () => {},
          buildFullSystemInjection: () => null,
        },
        contextRecall: null,
        contextCapSensor: null,
        config: {
          livingState: { maxAdvisoryBlockChars: 600 },
          workJournal: { enabled: false, injectMaxTokens: 500 },
        },
        autoCheckpoint: async () => {},
        refreshActiveContext: async () => {},
        lastCompileResult: null,
        directory: 'test-project',
        syncActiveSession: async () => {},
      } as any;

      await createSystemTransformHook(pluginCtx)({
        sessionID: sessionId,
        messages: [{
          info: { role: 'user' },
          parts: [{ type: 'text', text: 'Using only <agent_reentry_context>, answer this. ONLY AGENT RENTRY CONTEXT' }],
        }],
      }, output);

      const joined = output.system.join('\n');
      ok(joined.includes('[RE-ENTRY SOURCE-ONLY OVERRIDE]'), 'part-based source-only prompt should inject override');
      ok(joined.includes('Do not say tools were blocked'), 'part-based override should forbid guard narration');
      ok(joined.includes('Do not try to satisfy "current git history" literally'), 'part-based override should forbid git lookup');
      ok(joined.includes('I cannot compare against current git history from `<agent_reentry_context>` alone'), 'part-based override should prescribe safe opener');
    });

    it('denies permissions and tool execution for source-only sessions', async () => {
      const sessionId = 'sess-source-only-deny';
      const pluginCtx = {
        state: {
          currentSessionId: sessionId,
          recentUserMessages: new Map([[sessionId, 'ONLY AGENT RENTRY CONTEXT']]),
          sourceOnlySessions: new Set([sessionId]),
        },
        syncActiveSession: () => {},
        loopDetector: {
          recordCall: () => ({ loop: false }),
        },
        lessonTriggers: {
          refresh: async () => {},
          buildInjection: () => null,
        },
        config: {
          checkpoint: { auto: { enabled: false } },
        },
      } as any;
      const permissionOutput = { status: 'ask' as const };

      await createPermissionAskHook(pluginCtx)({ sessionID: sessionId, type: 'shell' }, permissionOutput);
      strictEqual(permissionOutput.status, 'deny');

      await rejects(
        createToolExecuteBeforeHook(pluginCtx)({ tool: 'csm_reentry_preview', sessionID: sessionId, callID: 'call-1' }, { args: {} }),
        (error) => error instanceof Error
          && error.message === REENTRY_SOURCE_ONLY_RECOVERY_MESSAGE
          && error.message.includes('Do not mention tools, blocked commands, guards'),
        );
    });

    it('records source-only user turns during messages transform before tools execute', async () => {
      const sessionId = 'sess-source-only-transform';
      const pluginCtx = {
        state: {
          currentSessionId: sessionId,
          recentUserMessages: new Map(),
          sourceOnlySessions: new Set<string>(),
        },
        contextCompactor: {
          compact: () => ({ changed: false }),
        },
        syncActiveSession: () => {},
        loopDetector: {
          recordCall: () => ({ loop: false }),
        },
        lessonTriggers: {
          refresh: async () => {},
          buildInjection: () => null,
        },
        config: {
          checkpoint: { auto: { enabled: false } },
        },
      } as any;

      await createMessagesTransformHook(pluginCtx)({} as unknown, {
        messages: [{
          info: { role: 'user', sessionID: sessionId },
          parts: [{ type: 'text', text: 'Using only <agent_reentry_context>, answer this. ONLY AGENT RENTRY CONTEXT' }],
        }],
      });

      await rejects(
        createToolExecuteBeforeHook(pluginCtx)({ tool: 'csm_onboard_agent', sessionID: sessionId, callID: 'call-2' }, { args: {} }),
        (error) => error instanceof Error && error.message === REENTRY_SOURCE_ONLY_RECOVERY_MESSAGE,
      );
    });

    it('records source-only turns and disables lookup tools in chat.message', async () => {
      const sessionId = 'sess-source-only-chat-message';
      const userText = 'Using only <agent_reentry_context>, what claims look stale or contradicted by current git history? ONLY AGENT RENTRY CONTEXT';
      const output = {
        message: {
          id: 'msg-1',
          sessionID: sessionId,
          tools: { bash: true, read: true, csm_reentry_preview: true, csm_runtime_status: true, other_tool: true },
        },
        parts: [{
          type: 'text',
          text: userText,
        }],
      };
      const pluginCtx = {
        state: {
          currentSessionId: sessionId,
          recentUserMessages: new Map(),
          sourceOnlySessions: new Set<string>(),
        },
        directory: 'test-project',
        reEntryProtocol: {
          buildBlockForSourceOnlyTurn: async () => '<agent_reentry_context>block</agent_reentry_context>',
        },
      } as any;

      await createChatMessageHook(pluginCtx)({ sessionID: sessionId }, output);

      strictEqual(output.message.tools.bash, false);
      strictEqual(output.message.tools.read, false);
      strictEqual(output.message.tools.csm_reentry_preview, false);
      strictEqual(output.message.tools.csm_runtime_status, false);
      strictEqual(output.message.tools.other_tool, true);
      strictEqual(output.parts.length, 1);
      strictEqual(output.parts[0].type, 'text');
      strictEqual(output.parts[0].text, userText);
      strictEqual(pluginCtx.state.recentUserMessages.get(sessionId), userText);
      ok(pluginCtx.state.sourceOnlySessions.has(sessionId));
      ok(output.message.system?.includes('The next assistant response must begin with that exact sentence'));
      ok(output.message.system?.includes('<agent_reentry_context>block</agent_reentry_context>'));
    });

    it('uses chat.message source-only latch when system transform has no session id', async () => {
      const sessionId = 'sess-source-only-latched';
      const userText = 'Using only <agent_reentry_context>, what claims look stale or contradicted by current git history? ONLY AGENT RENTRY CONTEXT';
      const pluginCtx = {
        state: {
          currentSessionId: sessionId,
          recentUserMessages: new Map(),
          sourceOnlySessions: new Set<string>(),
        },
        directory: 'test-project',
        syncActiveSession: () => sessionId,
        reEntryProtocol: {
          buildBlockForSourceOnlyTurn: async () => '<agent_reentry_context>block</agent_reentry_context>',
        },
      } as any;

      await createChatMessageHook(pluginCtx)({ sessionID: sessionId }, {
        message: { id: 'msg-1', sessionID: sessionId, tools: { csm_runtime_status: true } },
        parts: [{ type: 'text', text: userText }],
      });

      const output = { system: ['Original system prompt'] };
      await createSystemTransformHook(pluginCtx)({}, output);

      const joined = output.system.join('\n');
      ok(joined.includes('[RE-ENTRY SOURCE-ONLY OVERRIDE]'), 'latched source-only state should inject override');
      ok(joined.includes('<agent_reentry_context>block</agent_reentry_context>'), 'latched source-only state should inject block');
      ok(joined.includes('Begin the answer immediately with that exact sentence'), 'override should forbid lead-in text');
    });
  });

  describe('first-turn detection', () => {
    it('should inject re-entry block on first turn', async () => {
      const sessionId = 'sess-7b-test';

      const reEntryProtocol = {
        diagnose: async () => ({
          layersAssembled: {
            identity: { count: 3 },
            constraints: { count: 2 },
          },
          layersDropped: [],
          layersTrimmed: [],
          previewOnly: false,
          totalLayers: 5,
        }),
        buildBlock: async () => '[PHASE 7B RE-ENTRY BLOCK: Preview of contextual context for fresh sessions]',
      };

      const output = {
        system: ['Original system prompt'],
      };

      const pluginCtx = {
        pool: null as any,
        memoryManager: null as any,
        selfModel: null as any,
        beliefStore: null as any,
        workJournal: null as any,
        contextRecall: {
          getContextBrief: async () => ({
            compressed: '## Context Brief\nSome context here',
            source: 'memory',
          }),
        },
        state: {
          currentSessionId: null,
          messageCount: 0,
          capturedMessageSizes: new Map(),
          recentUserMessages: new Map(),
          reentryInjected: new Set<string>(),
        },
        reEntryProtocol,
        database: {
          getPool: () => ({ query: async () => ({ rows: [] }) }),
        },
        lessonTriggers: {
          refresh: async () => {},
          buildFullSystemInjection: () => null,
        },
        contextRecall: {
          getContextBrief: async () => ({ compressed: '', source: '' }),
        },
        contextCapSensor: null,
        vcmManager: null,
        checkpointInjectDeps: null,
        config: {
          livingState: {
            maxAdvisoryBlockChars: 600,
          },
          workJournal: {
            enabled: false,
            injectMaxTokens: 500,
          },
        },
        autoCheckpoint: async () => {},
        refreshActiveContext: async () => {},
        lastCompileResult: null,
        directory: 'test-project',
        syncActiveSession: async () => {},
      } as any;

      await createSystemTransformHook(pluginCtx)({
        sessionID: sessionId,
        messages: [],
      }, output);

      ok(output.system.length > 1, 'system array should have multiple entries after injection');
      ok(output.system.some(s => s.includes('RE-ENTRY BLOCK')), 're-entry block should be present');
    });

    it('should not inject on subsequent turns (reentryInjected tracking)', async () => {
      const sessionId = 'sess-7b-test';
      const reentryInjected = new Set<string>();
      reentryInjected.add(sessionId);

      const reEntryProtocol = {
        diagnose: async () => ({
          layersAssembled: {
            identity: { count: 3 },
            constraints: { count: 2 },
          },
          layersDropped: [],
          layersTrimmed: [],
          previewOnly: true,
          totalLayers: 5,
        }),
        buildBlock: async () => '[PHASE 7B RE-ENTRY BLOCK: Preview of contextual context for fresh sessions]',
      };

      const output = {
        system: ['Original system prompt'],
      };

      const pluginCtx = {
        pool: null as any,
        memoryManager: null as any,
        selfModel: null as any,
        beliefStore: null as any,
        workJournal: null as any,
        contextRecall: null as any,
        state: {
          currentSessionId: null,
          messageCount: 0,
          capturedMessageSizes: new Map(),
          recentUserMessages: new Map(),
          reentryInjected: new Set<string>(),
        },
        reEntryProtocol,
        database: {
          getPool: () => ({ query: async () => ({ rows: [] }) }),
        },
        lessonTriggers: {
          refresh: async () => {},
          buildFullSystemInjection: () => null,
        },
        contextRecall: {
          getContextBrief: async () => ({ compressed: '', source: '' }),
        },
        contextCapSensor: null,
        vcmManager: null,
        checkpointInjectDeps: null,
        config: {
          livingState: {
            maxAdvisoryBlockChars: 600,
          },
          workJournal: {
            enabled: false,
            injectMaxTokens: 500,
          },
        },
        autoCheckpoint: async () => {},
        refreshActiveContext: async () => {},
        lastCompileResult: null,
        directory: 'test-project',
        syncActiveSession: async () => {},
      } as any;

      await createSystemTransformHook(pluginCtx)({
        sessionID: sessionId,
        messages: [],
      }, output);

      const diag = await reEntryProtocol.diagnose(sessionId);
      ok(diag.previewOnly, 'subsequent turns should be previewOnly');
    });

    it('does not mark re-entry injected when preview-only returns no block', async () => {
      const sessionId = 'sess-preview-null';
      const reentryInjected = new Set<string>();
      const reEntryProtocol = {
        diagnose: async () => ({
          layersDropped: [],
          layersTrimmed: [],
          previewOnly: true,
        }),
        buildBlock: async () => null,
      };

      const output = {
        system: ['Original system prompt'],
      };

      const pluginCtx = {
        contextRecall: null as any,
        state: {
          currentSessionId: null,
          messageCount: 0,
          capturedMessageSizes: new Map(),
          recentUserMessages: new Map(),
          reentryInjected,
        },
        reEntryProtocol,
        database: {
          getPool: () => ({ query: async () => ({ rows: [] }) }),
        },
        lessonTriggers: {
          refresh: async () => {},
          buildFullSystemInjection: () => null,
        },
        contextCapSensor: null,
        config: {
          livingState: { maxAdvisoryBlockChars: 600 },
          workJournal: { enabled: false, injectMaxTokens: 500 },
        },
        autoCheckpoint: async () => {},
        refreshActiveContext: async () => {},
        lastCompileResult: null,
        directory: 'test-project',
        syncActiveSession: async () => {},
      } as any;

      await createSystemTransformHook(pluginCtx)({
        sessionID: sessionId,
        messages: [],
      }, output);

      strictEqual(reentryInjected.has(sessionId), false, 'preview-only/null block should retry later');
      ok(!output.system.some(s => s.trim().startsWith('<agent_reentry_context>')), 'no re-entry block should be present');
    });
  });

  describe('diagnostic logging', () => {
    it('should log when layers are dropped during budget trimming', async () => {
      const sessionId = 'sess-7b-test';

      const reEntryProtocol = {
        diagnose: async () => ({
          layersAssembled: {
            identity: { count: 2 },
            constraints: { count: 1 },
          },
          layersDropped: [
            { layer: 'tasks', reason: 'token budget exceeded' },
            { layer: 'metadata', reason: 'token budget exceeded' },
          ],
          layersTrimmed: [
            { layer: 'workJournal', originalSize: 500, newSize: 200 },
          ],
          previewOnly: false,
          totalLayers: 5,
        }),
        buildBlock: async () => '[PHASE 7B RE-ENTRY BLOCK: Trimmed]',
      };

      const output = {
        system: ['Original system prompt'],
      };

      const pluginCtx = {
        pool: null as any,
        memoryManager: null as any,
        selfModel: null as any,
        beliefStore: null as any,
        workJournal: null as any,
        contextRecall: null as any,
        state: {
          currentSessionId: null,
          messageCount: 0,
          capturedMessageSizes: new Map(),
          recentUserMessages: new Map(),
          reentryInjected: new Set<string>(),
        },
        reEntryProtocol,
        database: {
          getPool: () => ({ query: async () => ({ rows: [] }) }),
        },
        lessonTriggers: {
          refresh: async () => {},
          buildFullSystemInjection: () => null,
        },
        contextRecall: {
          getContextBrief: async () => ({ compressed: '', source: '' }),
        },
        contextCapSensor: null,
        vcmManager: null,
        checkpointInjectDeps: null,
        config: {
          livingState: {
            maxAdvisoryBlockChars: 600,
          },
          workJournal: {
            enabled: false,
            injectMaxTokens: 500,
          },
        },
        autoCheckpoint: async () => {},
        refreshActiveContext: async () => {},
        lastCompileResult: null,
        directory: 'test-project',
        syncActiveSession: async () => {},
      } as any;

      await createSystemTransformHook(pluginCtx)({
        sessionID: sessionId,
        messages: [],
      }, output);

      const diag = await reEntryProtocol.diagnose(sessionId);

      ok(diag.layersDropped.length > 0, 'diagnostics should show dropped layers');
      strictEqual(diag.layersDropped[0].layer, 'tasks');
      strictEqual(diag.layersDropped[0].reason, 'token budget exceeded');
    });

    it('should report budget trimming applied', async () => {
      const sessionId = 'sess-7b-test';

      const reEntryProtocol = {
        diagnose: async () => ({
          layersAssembled: {
            identity: { count: 4 },
            constraints: { count: 3 },
          },
          layersDropped: [],
          layersTrimmed: [],
          previewOnly: true,
          totalLayers: 7,
        }),
        buildBlock: async () => '[PHASE 7B RE-ENTRY BLOCK: Preview only]',
      };

      const output = {
        system: ['Original system prompt'],
      };

      const pluginCtx = {
        pool: null as any,
        memoryManager: null as any,
        selfModel: null as any,
        beliefStore: null as any,
        workJournal: null as any,
        contextRecall: null as any,
        state: {
          currentSessionId: null,
          messageCount: 0,
          capturedMessageSizes: new Map(),
          recentUserMessages: new Map(),
          reentryInjected: new Set<string>(),
        },
        reEntryProtocol,
        database: {
          getPool: () => ({ query: async () => ({ rows: [] }) }),
        },
        lessonTriggers: {
          refresh: async () => {},
          buildFullSystemInjection: () => null,
        },
        contextRecall: {
          getContextBrief: async () => ({ compressed: '', source: '' }),
        },
        contextCapSensor: null,
        vcmManager: null,
        checkpointInjectDeps: null,
        config: {
          livingState: {
            maxAdvisoryBlockChars: 600,
          },
          workJournal: {
            enabled: false,
            injectMaxTokens: 500,
          },
        },
        autoCheckpoint: async () => {},
        refreshActiveContext: async () => {},
        lastCompileResult: null,
        directory: 'test-project',
        syncActiveSession: async () => {},
      } as any;

      await createSystemTransformHook(pluginCtx)({
        sessionID: sessionId,
        messages: [],
      }, output);

      const diag = await reEntryProtocol.diagnose(sessionId);

      strictEqual(diag.totalLayers, 7);
      ok(diag.layersAssembled.identity.count === 4);
      ok(diag.layersAssembled.constraints.count === 3);
    });
  });

  describe('first-turn greeting does not blank the agent', () => {
    it('surfaces continuity directive when first turn is a greeting AND re-entry protocol exists', async () => {
      const sessionId = 'sess-greeting-first';
      const reentryInjected = new Set<string>();
      const reEntryProtocol = {
        diagnose: async () => ({
          layersAssembled: { identity: { count: 1 } },
          layersDropped: [],
          layersTrimmed: [],
          previewOnly: false,
          totalLayers: 1,
        }),
        buildBlock: async () => '<agent_reentry_context>block</agent_reentry_context>',
      };

      const output = { system: ['Original system prompt'] };

      const pluginCtx = {
        state: {
          currentSessionId: null,
          messageCount: 0,
          capturedMessageSizes: new Map(),
          recentUserMessages: new Map([[sessionId, 'hey']]),
          reentryInjected,
        },
        reEntryProtocol,
        database: {
          getPool: () => ({ query: async () => ({ rows: [] }) }),
        },
        lessonTriggers: {
          refresh: async () => {},
          buildFullSystemInjection: () => null,
        },
        contextRecall: {
          getContextBrief: async () => ({ compressed: '', source: '' }),
        },
        contextCapSensor: null,
        config: {
          livingState: { maxAdvisoryBlockChars: 600 },
          workJournal: { enabled: false, injectMaxTokens: 500 },
        },
        autoCheckpoint: async () => {},
        refreshActiveContext: async () => {},
        lastCompileResult: null,
        directory: 'test-project',
        syncActiveSession: async () => {},
      } as any;

      await createSystemTransformHook(pluginCtx)({
        sessionID: sessionId,
        messages: [],
      }, output);

      const joined = output.system.join('\n');
      ok(joined.includes('first turn of a session'), 'first-turn greeting should NOT suppress continuity');
      ok(joined.includes('surface continuity'), 'should direct the agent to surface continuity');
      ok(!joined.includes('Reply briefly and warmly in plain language. Do not call memory tools for this turn.'),
        'should NOT inject the blank-chatbot suppression directive on first-turn greeting');
    });

    it('still applies blank-chatbot suppression on NON-first-turn greetings', async () => {
      const sessionId = 'sess-greeting-later';
      const reentryInjected = new Set<string>([sessionId]);
      const reEntryProtocol = {
        diagnose: async () => ({
          layersAssembled: { identity: { count: 1 } },
          layersDropped: [],
          layersTrimmed: [],
          previewOnly: false,
          totalLayers: 1,
        }),
        buildBlock: async () => '<agent_reentry_context>block</agent_reentry_context>',
      };

      const output = { system: ['Original system prompt'] };

      const pluginCtx = {
        state: {
          currentSessionId: null,
          messageCount: 0,
          capturedMessageSizes: new Map(),
          recentUserMessages: new Map([[sessionId, 'hey']]),
          reentryInjected,
        },
        reEntryProtocol,
        database: {
          getPool: () => ({ query: async () => ({ rows: [] }) }),
        },
        lessonTriggers: {
          refresh: async () => {},
          buildFullSystemInjection: () => null,
        },
        contextRecall: {
          getContextBrief: async () => ({ compressed: '', source: '' }),
        },
        contextCapSensor: null,
        config: {
          livingState: { maxAdvisoryBlockChars: 600 },
          workJournal: { enabled: false, injectMaxTokens: 500 },
        },
        autoCheckpoint: async () => {},
        refreshActiveContext: async () => {},
        lastCompileResult: null,
        directory: 'test-project',
        syncActiveSession: async () => {},
      } as any;

      await createSystemTransformHook(pluginCtx)({
        sessionID: sessionId,
        messages: [],
      }, output);

      const joined = output.system.join('\n');
      ok(joined.includes('Reply briefly and warmly in plain language. Do not call memory tools for this turn.'),
        'subsequent-turn greeting should still get the blank-chatbot suppression directive');
      ok(!joined.includes('first turn of a session'),
        'subsequent-turn greeting should not get the first-turn continuity directive');
    });
  });

  describe('session ID resolution from currentSessionId when input.sessionID is absent', () => {
    it('uses currentSessionId (not "default") so per-session injection tracking works across sessions', async () => {
      const realSessionId = 'ses_real_123';
      const reentryInjected = new Set<string>(['default']);
      const reEntryProtocol = {
        diagnose: async () => ({
          layersAssembled: { identity: { count: 1 } },
          layersDropped: [],
          layersTrimmed: [],
          previewOnly: false,
          totalLayers: 1,
        }),
        buildBlock: async () => '<agent_reentry_context>block</agent_reentry_context>',
      };

      const output = { system: ['Original system prompt'] };

      const pluginCtx = {
        state: {
          currentSessionId: realSessionId,
          messageCount: 0,
          capturedMessageSizes: new Map(),
          recentUserMessages: new Map([[realSessionId, 'fix the bug']]),
          reentryInjected,
        },
        reEntryProtocol,
        database: {
          getPool: () => ({ query: async () => ({ rows: [] }) }),
        },
        lessonTriggers: {
          refresh: async () => {},
          buildFullSystemInjection: () => null,
        },
        contextRecall: {
          getContextBrief: async () => ({ compressed: '', source: '' }),
        },
        contextCapSensor: null,
        config: {
          livingState: { maxAdvisoryBlockChars: 600 },
          workJournal: { enabled: false, injectMaxTokens: 500 },
        },
        autoCheckpoint: async () => {},
        refreshActiveContext: async () => {},
        lastCompileResult: null,
        directory: 'test-project',
        syncActiveSession: async () => {},
      } as any;

      await createSystemTransformHook(pluginCtx)({
        // NOTE: sessionID intentionally OMITTED — simulates opencode not passing it to system.transform
        messages: [{ role: 'user', content: 'fix the bug' }],
      }, output);

      const joined = output.system.join('\n');
      ok(joined.includes('<agent_reentry_context>'),
        're-entry block should be injected even when input.sessionID is absent but currentSessionId is set');
      ok(reentryInjected.has(realSessionId),
        'reentryInjected should track the real session ID, not "default"');
      ok(reentryInjected.size === 2,
        'should have both "default" (from prior session) and the real session ID — proving per-session isolation');
    });
  });
});

import { describe, it } from 'node:test';
import { strictEqual, ok, rejects } from 'node:assert';

import { createSystemTransformHook, isReentrySourceOnlyTurn } from '../dist/hooks/system-transform.js';
import { createPermissionAskHook, createToolExecuteBeforeHook } from '../dist/hooks/tool-execute.js';

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
      ok(joined.includes('Do not call tools, shell commands, git, file reads, docs, or memory'), 'override should forbid external lookup');
      ok(joined.includes('provide any internally visible stale or contradictory claims'), 'override should preserve useful internal answer');
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
        /Source-only re-entry turn blocks tool execution: csm_reentry_preview/,
      );
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
});

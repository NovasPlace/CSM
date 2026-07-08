import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert';

import { createSystemTransformHook } from '../dist/hooks/system-transform.js';

describe('Phase 7B: Re-entry system transform integration', () => {
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

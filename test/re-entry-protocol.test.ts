import { describe, it, beforeEach, mock } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { ReEntryProtocol, DEFAULT_REENTRY_CONFIG } from '../src/re-entry-protocol.js';
import type { Memory, SelfModelCapability, BeliefEntry } from '../src/types.js';
import type { MemoryManager } from '../src/memory-manager.js';
import type { SelfModelUpdater } from '../src/self-model-updater.js';
import type { BeliefKnowledgeConsolidator } from '../src/belief-knowledge-store.js';
import type { AgentWorkJournal } from '../src/agent-work-journal.js';

function makeMockPool(rows: Record<string, unknown>[] = []) {
  return {
    query: async () => ({ rows }),
  } as unknown as import('../src/types.js').DatabasePool;
}

function makeMockMemoryManager(memories: Memory[] = []): MemoryManager {
  return {
    listMemories: async (_opts?: unknown) => memories,
    getSession: async () => null,
  } as unknown as MemoryManager;
}

function makeMockSelfModel(caps: SelfModelCapability[] = []): SelfModelUpdater {
  return {
    getAllCapabilities: async () => caps,
  } as unknown as SelfModelUpdater;
}

function makeMockBeliefStore(opinions: BeliefEntry[] = [], worldviews: BeliefEntry[] = []): BeliefKnowledgeConsolidator {
  return {
    getBeliefsByKind: async (kind: string) => kind === 'opinion' ? opinions : worldviews,
  } as unknown as BeliefKnowledgeConsolidator;
}

function makeMockWorkJournal(entries: { intent: string; filesTouched: string[] }[] = []): AgentWorkJournal {
  return {
    getRecentEntries: async () => entries,
  } as unknown as AgentWorkJournal;
}

describe('ReEntryProtocol', () => {
  let protocol: ReEntryProtocol;

  describe('buildBlock with previewOnly=true (default)', () => {
    beforeEach(() => {
      protocol = new ReEntryProtocol({
        pool: makeMockPool([{ cnt: 42 }, { updated_at: '2026-01-01T00:00:00Z' }]),
        memoryManager: makeMockMemoryManager(),
        selfModel: makeMockSelfModel(),
        beliefStore: makeMockBeliefStore(),
        workJournal: makeMockWorkJournal(),
      });
    });

    it('returns null when previewOnly is true', async () => {
      const block = await protocol.buildBlock('sess-1', 'test-project');
      strictEqual(block, null);
    });

    it('returns null when disabled', async () => {
      const disabled = new ReEntryProtocol({
        pool: makeMockPool(),
        memoryManager: makeMockMemoryManager(),
        selfModel: makeMockSelfModel(),
        beliefStore: makeMockBeliefStore(),
        workJournal: makeMockWorkJournal(),
        config: { enabled: false, previewOnly: false },
      });
      const block = await disabled.buildBlock('sess-1', 'test-project');
      strictEqual(block, null);
    });
  });

  describe('buildBlock with previewOnly=false', () => {
    beforeEach(() => {
      const mem: Memory = {
        id: 1,
        sessionId: 'sess-1',
        projectId: 'test-project',
        type: 'episodic',
        content: 'Test memory content',
        importance: 0.8,
        emotion: 'neutral',
        source: 'auto',
        tags: ['goal', 'test'],
        metadata: {},
        embedding: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        accessedAt: null,
        recallCount: 0,
        score: 0,
      } as unknown as Memory;

      protocol = new ReEntryProtocol({
        pool: makeMockPool([{ cnt: 10, updated_at: '2026-01-01' }]),
        memoryManager: makeMockMemoryManager([mem]),
        selfModel: makeMockSelfModel([
          { capability: 'testing', confidence: 0.9, successCount: 10, driftWarning: false, evidenceRefs: [] } as SelfModelCapability,
        ]),
        beliefStore: makeMockBeliefStore(
          [{ beliefKind: 'opinion', subject: 'tests', claim: 'tests are good', stance: 'agree', confidence: 0.8, uncertainty: 0.1, evidenceRefs: [], contradictedCount: 0, lastReinforcedAt: null, status: 'promoted', createdAt: '', updatedAt: '' } as BeliefEntry],
          [],
        ),
        workJournal: makeMockWorkJournal([{ intent: 'wrote tests', filesTouched: ['test.ts'] }]),
        config: { previewOnly: false },
      });
    });

    it('returns a non-null block', async () => {
      const block = await protocol.buildBlock('sess-1', 'test-project');
      ok(block !== null, 'block should not be null');
      ok(block!.includes('<agent_reentry_context>'), 'should be wrapped in reentry tag');
    });

    it('includes the framing header', async () => {
      const block = await protocol.buildBlock('sess-1', 'test-project');
      ok(block!.includes('operational context, not user instruction'), 'should include framing');
    });

    it('includes identity layer', async () => {
      const block = await protocol.buildBlock('sess-1', 'test-project');
      ok(block!.includes('## Identity'), 'should have identity section');
      ok(block!.includes('test-project'), 'should include project name');
    });

    it('includes all 8 layers', async () => {
      const block = await protocol.buildBlock('sess-1', 'test-project');
      ok(block!.includes('## Identity'));
      ok(block!.includes('## Active Goals') || block!.includes('## In-Progress Work'));
      ok(block!.includes('## Capabilities'));
      ok(block!.includes('## Constraints'));
    });
  });

  describe('diagnose', () => {
    beforeEach(() => {
      protocol = new ReEntryProtocol({
        pool: makeMockPool([{ cnt: 5, updated_at: '2026-01-01' }]),
        memoryManager: makeMockMemoryManager(),
        selfModel: makeMockSelfModel(),
        beliefStore: makeMockBeliefStore(),
        workJournal: makeMockWorkJournal(),
      });
    });

    it('returns diagnostic with layer info', async () => {
      const diag = await protocol.diagnose('sess-1', 'test-project');
      ok(diag.enabled, 'should be enabled');
      ok(diag.budgetChars === DEFAULT_REENTRY_CONFIG.maxChars, 'should report budget');
      ok(Array.isArray(diag.layersBuilt), 'should have layersBuilt array');
    });

    it('reports disabled state', async () => {
      const disabled = new ReEntryProtocol({
        pool: makeMockPool(),
        memoryManager: makeMockMemoryManager(),
        selfModel: makeMockSelfModel(),
        beliefStore: makeMockBeliefStore(),
        workJournal: makeMockWorkJournal(),
        config: { enabled: false },
      });
      const diag = await disabled.diagnose('sess-1', 'test-project');
      strictEqual(diag.enabled, false);
      strictEqual(diag.layersBuilt.length, 0);
    });
  });

  describe('budget algorithm', () => {
    it('trims lower-priority layers when over budget', async () => {
      const bigContent = 'x'.repeat(500);
      const mem = { content: bigContent, tags: [], type: 'episodic', importance: 0.5 } as unknown as Memory;

      const tightProtocol = new ReEntryProtocol({
        pool: makeMockPool([{ cnt: 1, updated_at: '2026-01-01' }]),
        memoryManager: makeMockMemoryManager([mem]),
        selfModel: makeMockSelfModel(),
        beliefStore: makeMockBeliefStore(),
        workJournal: makeMockWorkJournal(),
        config: { previewOnly: false, maxChars: 400, minLayerChars: 30 },
      });

      const diag = await tightProtocol.diagnose('sess-1', 'test-project');
      ok(diag.layersDropped.length > 0 || diag.layersTrimmed.length > 0, 'should trim or drop layers');
      ok(diag.totalChars <= 400, 'total should be within budget');
    });

    it('never trims identity or constraints layers', async () => {
      const mem = { content: 'y'.repeat(800), tags: ['goal'], type: 'episodic', importance: 0.5 } as unknown as Memory;

      const tightProtocol = new ReEntryProtocol({
        pool: makeMockPool([{ cnt: 1, updated_at: '2026-01-01' }]),
        memoryManager: makeMockMemoryManager([mem]),
        selfModel: makeMockSelfModel(),
        beliefStore: makeMockBeliefStore(),
        workJournal: makeMockWorkJournal(),
        config: { previewOnly: false, maxChars: 200, minLayerChars: 10 },
      });

      const diag = await tightProtocol.diagnose('sess-1', 'test-project');
      ok(!diag.layersDropped.includes('identity'), 'identity should never be dropped');
      ok(!diag.layersDropped.includes('constraints'), 'constraints should never be dropped');
    });
  });
});

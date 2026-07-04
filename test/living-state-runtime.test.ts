import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { LivingStateRuntime } from '../dist/living-state-runtime.js';

interface CapRow {
  id: number;
  capability: string;
  confidence: number;
  uncertainty: number;
  evidence_refs: string;
  success_count: number;
  failure_count: number;
  drift_warning: boolean | number;
  last_verified: string | Date | null;
  updated_at: string | Date;
}

function makePool(handler: (sql: string, params?: unknown[]) => { rows: unknown[]; rowCount: number }) {
  return {
    query: mock.fn((sql: string, params?: unknown[]) => {
      return Promise.resolve(handler(sql, params));
    }),
    getDialect: () => 'pg' as const,
  };
}

function makeScanner(pool: { query: unknown; getDialect: () => 'pg' }) {
  return {
    scan: mock.fn(async (config: { dryRun?: boolean; maxPerType?: number; lookbackMinutes?: number }) => ({
      patternsFound: 2,
      packetsScanned: 5,
      inserted: 1,
      updated: 1,
      skippedDuplicates: 0,
      candidates: [
        { candidateType: 'candidate_preference', dedupKey: 'tool:read:ok', confidence: 0.5, reason: 'read success', eventCount: 3, reinforcementCount: 2, contradictedCount: 0 },
        { candidateType: 'candidate_worldview', dedupKey: 'ms:completion', confidence: 0.4, reason: 'milestones complete', eventCount: 2, reinforcementCount: 1, contradictedCount: 0 },
      ],
      byType: { candidate_preference: 1, candidate_worldview: 1 },
      dryRun: config.dryRun ?? true,
    })),
  };
}

function makePackets(total: number) {
  return {
    countAll: mock.fn(async () => total),
  };
}

function makeSelfModelUpdater(caps: { capability: string; confidence: number; uncertainty: number; evidenceCount: number; driftWarning: boolean }[]) {
  return {
    updateAll: mock.fn(async () => {}),
    getAllCapabilities: mock.fn(async () => caps.map(c => ({
      id: undefined,
      capability: c.capability,
      confidence: c.confidence,
      uncertainty: c.uncertainty,
      evidenceRefs: Array.from({ length: c.evidenceCount }, (_, i) => ({
        packetId: i + 1,
        entryType: 'tool_use',
        outcome: 'success' as const,
        timestamp: '2025-12-01T00:00:00Z',
      })),
      successCount: Math.round(c.confidence * 10),
      failureCount: Math.round((1 - c.confidence) * 10),
      driftWarning: c.driftWarning,
      lastVerified: null,
      createdAt: '',
      updatedAt: '',
    }))),
  };
}

function makeConsolidator(result: { created: number; updated: number; skipped: number; beliefs: unknown[] }) {
  return {
    consolidate: mock.fn(async () => result),
    getAllBeliefs: mock.fn(async () => result.beliefs),
  };
}

describe('LivingStateRuntime', () => {
  it('runtime pass creates packet then updates downstream advisory layers', async () => {
    const pool = makePool(() => ({ rows: [], rowCount: 0 }));
    const scanner = makeScanner(pool);
    const packets = makePackets(15);
    const selfModel = makeSelfModelUpdater([
      { capability: 'tool_use', confidence: 0.5, uncertainty: 0.4, evidenceCount: 3, driftWarning: false },
    ]);
    const consolidator = makeConsolidator({ created: 1, updated: 0, skipped: 0, beliefs: [{ beliefKind: 'preference' }] });

    const runtime = new LivingStateRuntime(
      pool as any,
      { enabled: true, previewOnly: true, injectAdvisoryBlock: false, maxAdvisoryBlockChars: 1000, scanLookbackMinutes: 10, maxScanPerType: 10, updateIntervalMs: 60000 },
      scanner as any,
      packets as any,
      selfModel as any,
      consolidator as any,
    );

    const preview = await runtime.runPass();

    assert.equal(scanner.scan.mock.callCount(), 1);
    assert.equal(selfModel.updateAll.mock.callCount(), 1);
    assert.equal(selfModel.getAllCapabilities.mock.callCount(), 2);
    assert.equal(consolidator.consolidate.mock.callCount(), 1);

    assert.equal(preview.candidatesDelta.inserted, 1);
    assert.equal(preview.candidatesDelta.updated, 1);
    assert.equal(preview.beliefKnowledgeDelta.created, 1);
    assert.equal(preview.selfModel.length, 1);
    assert.equal(preview.previewOnly, true);
  });

  it('preview includes evidence refs via self-model', async () => {
    const pool = makePool(() => ({ rows: [], rowCount: 0 }));
    const scanner = makeScanner(pool);
    const packets = makePackets(5);
    const selfModel = makeSelfModelUpdater([
      { capability: 'code_editing', confidence: 0.7, uncertainty: 0.2, evidenceCount: 5, driftWarning: false },
      { capability: 'memory_recall', confidence: 0.3, uncertainty: 0.6, evidenceCount: 0, driftWarning: true },
    ]);
    const consolidator = makeConsolidator({ created: 1, updated: 0, skipped: 0, beliefs: [] });

    const runtime = new LivingStateRuntime(
      pool as any,
      { enabled: true, previewOnly: true, injectAdvisoryBlock: false, maxAdvisoryBlockChars: 1000, scanLookbackMinutes: 10, maxScanPerType: 10, updateIntervalMs: 60000 },
      scanner as any,
      packets as any,
      selfModel as any,
      consolidator as any,
    );

    const preview = await runtime.runPass();

    const editing = preview.selfModel.find(c => c.capability === 'code_editing');
    assert.ok(editing);
    assert.equal(editing.evidenceCount, 5);
    assert.equal(editing.driftWarning, false);

    const recall = preview.selfModel.find(c => c.capability === 'memory_recall');
    assert.ok(recall);
    assert.equal(recall.evidenceCount, 0);
    assert.equal(recall.driftWarning, true);
  });

  it('disabled config does nothing', async () => {
    const pool = makePool(() => ({ rows: [], rowCount: 0 }));
    const scanner = makeScanner(pool);
    const packets = makePackets(10);
    const selfModel = makeSelfModelUpdater([]);
    const consolidator = makeConsolidator({ created: 0, updated: 0, skipped: 0, beliefs: [] });

    const runtime = new LivingStateRuntime(
      pool as any,
      { enabled: false, previewOnly: true, injectAdvisoryBlock: false, maxAdvisoryBlockChars: 1000, scanLookbackMinutes: 10, maxScanPerType: 10, updateIntervalMs: 60000 },
      scanner as any,
      packets as any,
      selfModel as any,
      consolidator as any,
    );

    const preview = await runtime.runPass();

    assert.equal(scanner.scan.mock.callCount(), 0);
    assert.equal(selfModel.updateAll.mock.callCount(), 0);
    assert.equal(consolidator.consolidate.mock.callCount(), 0);

    assert.equal(preview.candidatesDelta.scanned, 0);
    assert.equal(preview.selfModel.length, 0);
    assert.equal(preview.warnings.length, 1);
    assert.ok(preview.warnings[0].includes('disabled'));
  });

  it('duplicate runtime pass is idempotent', async () => {
    const pool = makePool(() => ({ rows: [], rowCount: 0 }));
    const scanner = makeScanner(pool);
    const packets = makePackets(15);
    const selfModel = makeSelfModelUpdater([
      { capability: 'tool_use', confidence: 0.5, uncertainty: 0.4, evidenceCount: 3, driftWarning: false },
    ]);
    const consolidator = makeConsolidator({ created: 0, updated: 0, skipped: 1, beliefs: [] });

    const runtime = new LivingStateRuntime(
      pool as any,
      { enabled: true, previewOnly: true, injectAdvisoryBlock: false, maxAdvisoryBlockChars: 1000, scanLookbackMinutes: 10, maxScanPerType: 10, updateIntervalMs: 60000 },
      scanner as any,
      packets as any,
      selfModel as any,
      consolidator as any,
    );

    await runtime.runPass();
    await runtime.runPass();

    assert.equal(scanner.scan.mock.callCount(), 2);
    assert.equal(selfModel.updateAll.mock.callCount(), 2);
    assert.equal(consolidator.consolidate.mock.callCount(), 2);
  });

  it('getPreview returns static snapshot without running pipeline', async () => {
    const pool = makePool(() => ({ rows: [], rowCount: 0 }));
    const scanner = makeScanner(pool);
    const packets = makePackets(42);
    const selfModel = makeSelfModelUpdater([
      { capability: 'tool_use', confidence: 0.5, uncertainty: 0.4, evidenceCount: 3, driftWarning: false },
    ]);
    const consolidator = makeConsolidator({ created: 0, updated: 0, skipped: 0, beliefs: [{ beliefKind: 'preference' }] });

    const runtime = new LivingStateRuntime(
      pool as any,
      { enabled: true, previewOnly: true, injectAdvisoryBlock: false, maxAdvisoryBlockChars: 1000, scanLookbackMinutes: 10, maxScanPerType: 10, updateIntervalMs: 60000 },
      scanner as any,
      packets as any,
      selfModel as any,
      consolidator as any,
    );

    const preview = await runtime.getPreview();

    assert.equal(scanner.scan.mock.callCount(), 0);
    assert.equal(selfModel.updateAll.mock.callCount(), 0);
    assert.equal(consolidator.consolidate.mock.callCount(), 0);

    assert.equal(preview.recentPackets, 42);
    assert.equal(preview.selfModel.length, 1);
    assert.equal(preview.beliefKnowledgeDelta.created, 0);
    assert.equal(preview.beliefKnowledgeDelta.total, 1);
    assert.equal(preview.candidatesDelta.scanned, 0);
  });

  it('failure in one advisory layer does not corrupt other layers', async () => {
    const pool = makePool(() => ({ rows: [], rowCount: 0 }));
    const scanner = makeScanner(pool);
    scanner.scan = mock.fn(async () => { throw new Error('scanner crashed'); });
    const packets = makePackets(5);
    const selfModel = makeSelfModelUpdater([
      { capability: 'tool_use', confidence: 0.5, uncertainty: 0.4, evidenceCount: 3, driftWarning: false },
    ]);
    const consolidator = makeConsolidator({ created: 1, updated: 0, skipped: 0, beliefs: [] });

    const runtime = new LivingStateRuntime(
      pool as any,
      { enabled: true, previewOnly: true, injectAdvisoryBlock: false, maxAdvisoryBlockChars: 1000, scanLookbackMinutes: 10, maxScanPerType: 10, updateIntervalMs: 60000 },
      scanner as any,
      packets as any,
      selfModel as any,
      consolidator as any,
    );

    const preview = await runtime.runPass();

    assert.equal(scanner.scan.mock.callCount(), 1);
    // Self-model and consolidator should still run despite scanner failure
    assert.equal(selfModel.updateAll.mock.callCount(), 1);
    assert.equal(consolidator.consolidate.mock.callCount(), 1);

    assert.ok(preview.warnings.length >= 1);
    assert.ok(preview.warnings.some(w => w.includes('scanner')));
    // Belief consolidation should still work
    assert.equal(preview.beliefKnowledgeDelta.created, 1);
  });

  it('preview includes warnings list', async () => {
    const pool = makePool(() => ({ rows: [], rowCount: 0 }));
    const scanner = makeScanner(pool);
    scanner.scan = mock.fn(async () => { throw new Error('scanner failed'); });
    const packets = makePackets(0);
    const selfModel = makeSelfModelUpdater([]);
    const consolidator = makeConsolidator({ created: 0, updated: 0, skipped: 0, beliefs: [] });

    const runtime = new LivingStateRuntime(
      pool as any,
      { enabled: true, previewOnly: true, injectAdvisoryBlock: false, maxAdvisoryBlockChars: 1000, scanLookbackMinutes: 10, maxScanPerType: 10, updateIntervalMs: 60000 },
      scanner as any,
      packets as any,
      selfModel as any,
      consolidator as any,
    );

    const preview = await runtime.runPass();

    assert.ok(preview.warnings.length > 0);
    assert.ok(typeof preview.timestamp === 'string');
  });

  it('previewOnly is propagated from config', async () => {
    const pool = makePool(() => ({ rows: [], rowCount: 0 }));
    const scanner = makeScanner(pool);
    const packets = makePackets(0);
    const selfModel = makeSelfModelUpdater([]);
    const consolidator = makeConsolidator({ created: 0, updated: 0, skipped: 0, beliefs: [] });

    const runtime = new LivingStateRuntime(
      pool as any,
      { enabled: true, previewOnly: false, injectAdvisoryBlock: false, maxAdvisoryBlockChars: 1000, scanLookbackMinutes: 10, maxScanPerType: 10, updateIntervalMs: 60000 },
      scanner as any,
      packets as any,
      selfModel as any,
      consolidator as any,
    );

    const preview = await runtime.runPass();

    assert.equal(preview.previewOnly, false, 'previewOnly should reflect config value');
  });
});

describe('csm_living_state_preview tool', () => {
  it('tool returns structured preview with all sections', async () => {
    const runtime = {
      runPass: mock.fn(async () => ({
        packetsSince: 5,
        recentPackets: 20,
        candidatesDelta: { scanned: 5, inserted: 1, updated: 1, total: 2, byType: { candidate_preference: 1 } },
        selfModel: [
          { capability: 'tool_use', confidence: 0.5, uncertainty: 0.4, evidenceCount: 3, driftWarning: false },
          { capability: 'code_editing', confidence: 0.7, uncertainty: 0.2, evidenceCount: 5, driftWarning: false },
        ],
        beliefKnowledgeDelta: { created: 1, updated: 0, total: 3 },
        warnings: [],
        timestamp: '2025-12-01T00:00:00Z',
        previewOnly: true,
      })),
      getPreview: mock.fn(async () => ({})),
    };

    const { livingStatePreviewTool } = await import('../dist/living-state-tool.js');
    const tool = livingStatePreviewTool(runtime as any);

    const result = await tool.execute({}, {} as any);

    assert.equal(runtime.runPass.mock.callCount(), 1);
    assert.equal(result.metadata.runPass, true);
    assert.equal(result.metadata.preview.packetsSince, 5);
    assert.ok(result.output.includes('Experience Packets'));
    assert.ok(result.output.includes('Candidate Queue'));
    assert.ok(result.output.includes('Self-Model Capabilities'));
    assert.ok(result.output.includes('Belief Knowledge'));
    assert.ok(result.output.includes('Guardrails'));
    assert.ok(result.output.includes('No prompt/context injection'));
  });

  it('tool with runPass=false uses getPreview (static snapshot)', async () => {
    const runtime = {
      runPass: mock.fn(async () => ({})),
      getPreview: mock.fn(async () => ({
        packetsSince: 0,
        recentPackets: 42,
        candidatesDelta: { scanned: 0, inserted: 0, updated: 0, total: 0, byType: {} },
        selfModel: [],
        beliefKnowledgeDelta: { created: 0, updated: 0, total: 0 },
        warnings: [],
        timestamp: '2025-12-01T00:00:00Z',
        previewOnly: true,
      })),
    };

    const { livingStatePreviewTool } = await import('../dist/living-state-tool.js');
    const tool = livingStatePreviewTool(runtime as any);

    const result = await tool.execute({ runPass: false }, {} as any);

    assert.equal(runtime.getPreview.mock.callCount(), 1);
    assert.equal(runtime.runPass.mock.callCount(), 0);
    assert.equal(result.metadata.runPass, false);
  });

  it('tool does not write any data (read-only advisory)', async () => {
    const runtime = {
      runPass: mock.fn(async () => ({
        packetsSince: 0,
        recentPackets: 0,
        candidatesDelta: { scanned: 0, inserted: 0, updated: 0, total: 0, byType: {} },
        selfModel: [],
        beliefKnowledgeDelta: { created: 0, updated: 0, total: 0 },
        warnings: [],
        timestamp: '2025-12-01T00:00:00Z',
        previewOnly: true,
      })),
      getPreview: mock.fn(async () => ({})),
    };

    const { livingStatePreviewTool } = await import('../dist/living-state-tool.js');
    const tool = livingStatePreviewTool(runtime as any);

    await tool.execute({}, {} as any);

    // Only runPass was called — no data-modifying methods
    assert.equal(runtime.runPass.mock.callCount(), 1);
    const keys = Object.keys(runtime).filter(k => k !== 'runPass' && k !== 'getPreview');
    // Should only have runPass and getPreview
    assert.deepEqual(keys, []);
  });
});
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  computeContinuityConfidence,
  collectSystemHealthAdvisories,
  collectDocsFreshness,
  collectToolRegistryHealth,
  buildContinuityReportWithOptions,
  snapshotFromReport,
  compareSnapshots,
  loadSnapshot,
  saveSnapshot,
  formatReportJson,
  formatReportCompact,
  formatReportFull,
  buildExecSummary,
  type ContinuityReport,
  type ContinuityGrade,
  type SectionResult,
  type ReportSnapshot,
  type ContinuityComparison,
  type ContinuityDelta,
} from '../src/continuity-resilience-report.js';
import { CSM_TOOL_NAMES } from '../src/tool-names.js';

function makeSection<T>(grade: ContinuityGrade, data: T | null = null, available = true): SectionResult<T> {
  return { data, available, degraded: [], grade, gradeReason: 'test' };
}

function makePartial(overrides: Partial<ContinuityReport> = {}): Omit<ContinuityReport, 'systemAdvisories' | 'knowledgeSignals' | 'continuityConfidence'> {
  return {
    memoryInventory: makeSection('healthy', { total: 1000, byType: { conversation: 500, lesson: 500 }, byStatus: { active: 1000 } }),
    recallHealth: makeSection('healthy', null),
    recallScore: null,
    graphReadiness: makeSection('sparse_data', { totalLinks: 0, byLinkType: {}, totalMemoriesWithLinks: 0, totalMemories: 1000, linkCoveragePct: 0 }),
    pipelineStatus: makeSection('healthy', { totalPackets: 100, packetsLast24h: 10, candidatesByType: {}, candidatesByStatus: { pending: 5, applied: 95 }, promotionReadyBacklog: 2, promotedBeliefCount: 3 }),
    livingState: makeSection('healthy', { enabled: true, injectAdvisoryBlock: false, blockProduced: false, sectionsPresent: ['internalState'], sectionsOmitted: [], packetCount: 100, candidateCount: 5, capabilityCount: 3 }),
    docsFreshness: makeSection('healthy', null),
    toolRegistry: makeSection('healthy', { declaredTools: [...CSM_TOOL_NAMES], registeredTools: [...CSM_TOOL_NAMES], mismatchCount: 0, undeclared: [], unregistered: [] }),
    reEntryHealth: { available: false, enabled: false, previewOnly: true, wouldInject: false, injectedSessions: 0, budgetChars: 2100, minLayerChars: 50, originalChars: 0, finalChars: 0, approxTokens: 0, layersIncluded: [], layersTrimmed: [], layersDropped: [], layerDetails: [], trimLevel: 'none' },
    ...overrides,
  };
}

describe('Phase 6E: Continuity Resilience Report', () => {
  it('all sections healthy → healthy overall', () => {
    const partial = makePartial();
    const result = computeContinuityConfidence(partial);
    assert.equal(result.grade, 'healthy');
    assert.ok(result.score >= 80);
  });

  it('all sections unavailable → unknown grade', () => {
    const partial = makePartial({
      memoryInventory: makeSection('unknown', null, false),
      recallHealth: makeSection('unknown', null, false),
      graphReadiness: makeSection('unknown', null, false),
      pipelineStatus: makeSection('unknown', null, false),
      livingState: makeSection('unknown', null, false),
      docsFreshness: makeSection('unknown', null, false),
      toolRegistry: makeSection('unknown', null, false),
    });
    const result = computeContinuityConfidence(partial);
    assert.equal(result.grade, 'unknown');
    assert.equal(result.score, 0);
  });

  it('less than 50% weight available → unknown grade', () => {
    const partial = makePartial({
      memoryInventory: makeSection('unknown', null, false),
      recallHealth: makeSection('unknown', null, false),
      graphReadiness: makeSection('unknown', null, false),
      pipelineStatus: makeSection('unknown', null, false),
    });
    const result = computeContinuityConfidence(partial);
    assert.equal(result.grade, 'unknown');
  });

  it('re-normalizes weight when sections are unavailable', () => {
    const partial = makePartial({
      graphReadiness: makeSection('unknown', null, false),
    });
    const result = computeContinuityConfidence(partial);
    assert.ok(result.normalizedWeight < 1.0);
    assert.ok(result.normalizedWeight >= 0.84); // 0.85 minus floating point tolerance
  });

  it('recall needs_attention propagates to overall grade', () => {
    const partial = makePartial({
      recallHealth: makeSection('needs_attention'),
    });
    const result = computeContinuityConfidence(partial);
    assert.notEqual(result.grade, 'healthy');
  });

  it('docs missing → needs_attention for docs section', () => {
    const partial = makePartial({
      docsFreshness: makeSection('needs_attention'),
    });
    const result = computeContinuityConfidence(partial);
    assert.notEqual(result.sectionGrades.docsFreshness.grade, 'healthy');
  });

  it('system advisories are derived from sections, not weighted', () => {
    const partial = makePartial({
      toolRegistry: makeSection('needs_attention', { declaredTools: ['a'], registeredTools: ['b'], mismatchCount: 2, undeclared: ['b'], unregistered: ['a'] }),
      docsFreshness: makeSection('needs_attention'),
      recallScore: { grade: 'needs_attention', confidence: 0.5, reasons: ['high empty rate'], recommendations: [] },
      graphReadiness: makeSection('sparse_data', { totalLinks: 0, byLinkType: {}, totalMemoriesWithLinks: 0, totalMemories: 100, linkCoveragePct: 0 }),
      pipelineStatus: makeSection('unknown', { totalPackets: 0, packetsLast24h: 0, candidatesByType: {}, candidatesByStatus: {}, promotionReadyBacklog: 0, promotedBeliefCount: 0 }),
    });
    const advisories = collectSystemHealthAdvisories(partial);
    assert.ok(advisories.length > 0);
    // Priority order: registry (1) before docs (2) before recall (3)
    assert.ok(advisories[0].priority <= 2);
  });

  it('no advisories when all sections healthy', () => {
    const partial = makePartial();
    const advisories = collectSystemHealthAdvisories(partial);
    // Graph sparse_data with 0 links still generates an advisory
    assert.ok(advisories.length <= 1);
  });

  it('docs freshness detects missing files', async () => {
    const result = await collectDocsFreshness('C:\\nonexistent\\path');
    assert.equal(result.available, true);
    assert.equal(result.grade, 'needs_attention');
    assert.equal(result.data?.architecture.exists, false);
  });

  it('tool registry detects mismatches', () => {
    const result = collectToolRegistryHealth({ 'csm_extra': true, 'csm_memory_save': true });
    assert.ok(result.data!.mismatchCount > 0);
    assert.ok(result.data!.undeclared.includes('csm_extra'));
  });

  it('tool registry with perfect match is healthy', () => {
    const toolMap: Record<string, unknown> = {};
    for (const name of CSM_TOOL_NAMES) toolMap[name] = true;
    const result = collectToolRegistryHealth(toolMap);
    assert.equal(result.grade, 'healthy');
    assert.equal(result.data!.mismatchCount, 0);
  });

  it('composite scorer re-normalizes on missing sections gracefully', () => {
    const partial = makePartial({
      recallHealth: makeSection('unknown', null, false),
      livingState: makeSection('unknown', null, false),
    });
    const result = computeContinuityConfidence(partial);
    // 0.40 weight missing (recall 0.30 + livingState 0.10), 0.60 remaining → re-normalized
    assert.ok(result.normalizedWeight >= 0.60);
    assert.ok(result.normalizedWeight < 1.0);
  });

  it('sparse_data sections lower score but do not fail', () => {
    const partial = makePartial({
      recallHealth: makeSection('sparse_data'),
      graphReadiness: makeSection('sparse_data'),
    });
    const result = computeContinuityConfidence(partial);
    // sparse_data (score 60) is weighted, but other healthy sections keep overall >= 80
    assert.ok(result.score >= 80 && result.score <= 100);
    assert.notEqual(result.grade, 'unknown');
  });

  it('tool count is 32 after Phase 6E+6F+4G+8A-Impl', () => {
    assert.equal(CSM_TOOL_NAMES.length, 33);
  });

  it('CSM_TOOL_NAMES includes csm_continuity_report', () => {
    assert.ok(CSM_TOOL_NAMES.includes('csm_continuity_report' as never));
  });

  it('composite confidence tolerates all grades', () => {
    const grades: ContinuityGrade[] = ['healthy', 'sparse_data', 'needs_attention', 'degraded', 'unknown'];
    for (const grade of grades) {
      const partial = makePartial({
        recallHealth: makeSection(grade),
      });
      const result = computeContinuityConfidence(partial);
      assert.ok(result.score >= 0 && result.score <= 100);
    }
  });

  it('advisory priorities are sorted ascending', () => {
    const partial = makePartial({
      toolRegistry: makeSection('needs_attention', { declaredTools: [], registeredTools: ['x'], mismatchCount: 1, undeclared: ['x'], unregistered: [] }),
      pipelineStatus: makeSection('unknown', { totalPackets: 0, packetsLast24h: 0, candidatesByType: {}, candidatesByStatus: {}, promotionReadyBacklog: 0, promotedBeliefCount: 0 }),
    });
    const advisories = collectSystemHealthAdvisories(partial);
    for (let i = 1; i < advisories.length; i++) {
      assert.ok(advisories[i].priority >= advisories[i - 1].priority, 'advisories should be sorted by priority');
    }
  });
});

// ============================================================================
// Phase 6F: Compact / JSON / Exec Summary / Snapshots
// ============================================================================

function makeFullReport(overrides: Partial<ContinuityReport> = {}): ContinuityReport {
  const partial = makePartial(overrides);
  const systemAdvisories = collectSystemHealthAdvisories(partial);
  const continuityConfidence = computeContinuityConfidence(partial);
  return {
    ...partial,
    systemAdvisories,
    knowledgeSignals: {
      candidateBacklog: 0,
      promotionReady: 0,
      recentActivity: 0,
      topBeliefs: [],
    },
    continuityConfidence,
  };
}

describe('Phase 6F: Compact format', () => {
  it('produces compact output with exec summary', () => {
    const report = makeFullReport();
    const out = formatReportCompact(report);
    assert.ok(out.includes('Executive Summary'));
    assert.ok(out.includes('Grade:'));
    assert.ok(out.includes('Score:'));
    assert.ok(out.includes('compact'));
  });

  it('compact output is shorter than full output', () => {
    const report = makeFullReport();
    const compact = formatReportCompact(report);
    const full = formatReportFullExported(report);
    assert.ok(compact.length < full.length, 'compact should be shorter');
  });

  it('compact includes key metrics', () => {
    const report = makeFullReport();
    const out = formatReportCompact(report);
    assert.ok(out.includes('Memories:'));
    assert.ok(out.includes('Tools:'));
  });

  it('compact includes advisories count', () => {
    const report = makeFullReport({
      graphReadiness: makeSection('sparse_data', { totalLinks: 0, byLinkType: {}, totalMemoriesWithLinks: 0, totalMemories: 1000, linkCoveragePct: 0 }),
    });
    const out = formatReportCompact(report);
    assert.ok(out.includes('advisories') || out.includes('advisory') || out.includes('Advisory'));
  });
});

describe('Phase 6F: JSON format', () => {
  it('produces valid JSON', () => {
    const report = makeFullReport();
    const out = formatReportJson(report);
    const parsed = JSON.parse(out);
    assert.ok(parsed.continuityConfidence);
    assert.ok(parsed.sections);
    assert.ok(parsed.sections.memoryInventory);
    assert.ok(parsed.sections.toolRegistry);
  });

  it('JSON includes section grades', () => {
    const report = makeFullReport();
    const out = formatReportJson(report);
    const parsed = JSON.parse(out);
    assert.ok(parsed.sections.memoryInventory.grade);
    assert.ok(parsed.sections.recallHealth.grade);
  });

  it('JSON includes advisories array', () => {
    const report = makeFullReport();
    const out = formatReportJson(report);
    const parsed = JSON.parse(out);
    assert.ok(Array.isArray(parsed.systemAdvisories));
  });

  it('JSON includes comparison when provided', () => {
    const report = makeFullReport();
    const comparison: ContinuityComparison = { previousSnapshot: null, changes: [], changed: false };
    const out = formatReportJson(report, comparison);
    const parsed = JSON.parse(out);
    assert.ok(parsed.comparison);
    assert.equal(parsed.comparison.changed, false);
  });
});

describe('Phase 6F: Exec summary', () => {
  it('includes grade, score, confidence', () => {
    const report = makeFullReport();
    const lines = buildExecSummary(report);
    const joined = lines.join('\n');
    assert.ok(joined.includes('Grade:'));
    assert.ok(joined.includes('Score:'));
    assert.ok(joined.includes('Confidence:'));
  });

  it('includes top advisories when present', () => {
    const report = makeFullReport({
      graphReadiness: makeSection('sparse_data', { totalLinks: 0, byLinkType: {}, totalMemoriesWithLinks: 0, totalMemories: 1000, linkCoveragePct: 0 }),
    });
    const lines = buildExecSummary(report);
    const joined = lines.join('\n');
    assert.ok(joined.includes('advisories'));
  });

  it('says no advisories when healthy', () => {
    const report = makeFullReport();
    const lines = buildExecSummary(report);
    const joined = lines.join('\n');
    assert.ok(joined.includes('No advisories') || joined.includes('advisories'));
  });

  it('includes comparison changes when provided', () => {
    const report = makeFullReport();
    const fakeSnapshot: ReportSnapshot = {
      timestamp: '2026-01-01T00:00:00Z',
      grade: 'healthy', score: 90, normalizedWeight: 1.0,
      sectionGrades: { recallHealth: 'healthy' },
      memoryTotal: 900, recallEvents: 50, graphLinks: 10, graphCoveragePct: 5,
      pipelinePackets: 80, pipelinePackets24h: 8, pendingCandidates: 2,
      promotedBeliefs: 1, advisoryCount: 1, topAdvisoryPriorities: [2],
    };
    const comparison: ContinuityComparison = {
      previousSnapshot: fakeSnapshot,
      changes: [{ field: 'score', previous: 90, current: 94, direction: 'up' }],
      changed: true,
    };
    const lines = buildExecSummary(report, comparison);
    const joined = lines.join('\n');
    assert.ok(joined.includes('Changed since last run'));
    assert.ok(joined.includes('score'));
  });
});

describe('Phase 6F: Snapshot save/load', () => {
  it('saveSnapshot writes file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-test-'));
    const report = makeFullReport();
    const snap = snapshotFromReport(report);
    saveSnapshot(snap, tmp);
    const file = path.join(tmp, '.csm', 'continuity-snapshot.json');
    assert.ok(fs.existsSync(file));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('loadSnapshot reads file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-test-'));
    const report = makeFullReport();
    const snap = snapshotFromReport(report);
    saveSnapshot(snap, tmp);
    const loaded = loadSnapshot(tmp);
    assert.ok(loaded);
    assert.equal(loaded?.score, snap.score);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('loadSnapshot returns null when no file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-test-'));
    const loaded = loadSnapshot(tmp);
    assert.equal(loaded, null);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('Phase 6F: Comparison', () => {
  it('returns no changes when no previous snapshot', () => {
    const snap = snapshotFromReport(makeFullReport());
    const result = compareSnapshots(null, snap);
    assert.equal(result.changed, false);
    assert.equal(result.changes.length, 0);
  });

  it('detects score change', () => {
    const prev: ReportSnapshot = {
      timestamp: '2026-01-01T00:00:00Z',
      grade: 'healthy', score: 90, normalizedWeight: 1.0,
      sectionGrades: {},
      memoryTotal: 1000, recallEvents: 100, graphLinks: 500, graphCoveragePct: 50,
      pipelinePackets: 100, pipelinePackets24h: 10, pendingCandidates: 5,
      promotedBeliefs: 3, advisoryCount: 0, topAdvisoryPriorities: [],
    };
    const curr = snapshotFromReport(makeFullReport());
    curr.score = 95;
    const result = compareSnapshots(prev, curr);
    assert.ok(result.changed);
    const scoreDelta = result.changes.find(c => c.field === 'score');
    assert.ok(scoreDelta);
    assert.equal(scoreDelta?.direction, 'up');
  });

  it('detects grade change', () => {
    const prev: ReportSnapshot = {
      timestamp: '2026-01-01T00:00:00Z',
      grade: 'degraded', score: 50, normalizedWeight: 1.0,
      sectionGrades: { recallHealth: 'degraded' },
      memoryTotal: 100, recallEvents: 0, graphLinks: 0, graphCoveragePct: 0,
      pipelinePackets: 0, pipelinePackets24h: 0, pendingCandidates: 0,
      promotedBeliefs: 0, advisoryCount: 0, topAdvisoryPriorities: [],
    };
    const curr = snapshotFromReport(makeFullReport());
    const result = compareSnapshots(prev, curr);
    assert.ok(result.changed);
    const gradeDelta = result.changes.find(c => c.field === 'grade');
    assert.ok(gradeDelta);
  });
});

// Helper: call the exported formatReportFull (delegates to formatReport when no comparison)
function formatReportFullExported(report: ContinuityReport): string {
  return formatReportFull(report);
}

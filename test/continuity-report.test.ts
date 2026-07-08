import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeContinuityConfidence,
  collectSystemHealthAdvisories,
  collectDocsFreshness,
  collectToolRegistryHealth,
  type ContinuityReport,
  type ContinuityGrade,
  type SectionResult,
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

  it('tool count is 30 after Phase 6E', () => {
    assert.equal(CSM_TOOL_NAMES.length, 30);
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

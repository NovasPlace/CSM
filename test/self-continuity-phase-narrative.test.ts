import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PhaseNarrativeBuilder, buildPhaseNarrative, formatPhaseNarrative } from '../src/self-continuity-phase-narrative.js';

describe('PhaseNarrativeBuilder', () => {
  it('builds narrative from canonical phases', () => {
    const result = buildPhaseNarrative();
    assert.ok(result.phases.length >= 3);
    assert.ok(result.narrative.includes('Phase 21'));
    assert.ok(result.narrative.includes('Phase 22'));
    assert.ok(result.confidence > 0.3);
  });

  it('includes causal links between adjacent phases', () => {
    const result = buildPhaseNarrative();
    assert.ok(result.links.length >= 3);
    const link21to22 = result.links.find(l => l.fromPhase === 21 && l.toPhase === 22);
    assert.ok(link21to22);
    assert.ok(link21to22.summary.length > 0);
  });

  it('filters to a phase range', () => {
    const result = buildPhaseNarrative(21, 23);
    assert.equal(result.phases.length, 3);
    assert.equal(result.phases[0].phase, 21);
    assert.equal(result.phases[2].phase, 23);
    assert.ok(!result.narrative.includes('Phase 24'));
  });

  it('detects narrative gaps when link is missing', () => {
    const builder = new PhaseNarrativeBuilder({
      phases: [
        { phase: 30, name: 'A', problem: 'x', action: 'y', result: 'z', downstreamChange: 'w' },
        { phase: 31, name: 'B', problem: 'x', action: 'y', result: 'z', downstreamChange: 'w' },
        { phase: 33, name: 'D', problem: 'x', action: 'y', result: 'z', downstreamChange: 'w' },
      ],
      links: [
        { fromPhase: 30, toPhase: 31, causationType: 'direct_fix', summary: 'test' },
      ],
    });
    const result = builder.buildNarrative();
    assert.ok(result.gaps.some(g => g.includes('31') && g.includes('33')));
  });

  it('reports isolated phase as gap', () => {
    const builder = new PhaseNarrativeBuilder({
      phases: [
        { phase: 40, name: 'X', problem: 'x', action: 'y', result: 'z', downstreamChange: 'w' },
        { phase: 41, name: 'Y', problem: 'x', action: 'y', result: 'z', downstreamChange: 'w' },
      ],
      links: [],
    });
    const result = builder.buildNarrative();
    assert.ok(result.gaps.length >= 1);
    assert.ok(result.gaps.some(g => g.includes('no causal links')));
  });

  it('computes confidence from link coverage', () => {
    const fullResult = buildPhaseNarrative(21, 22);
    assert.ok(fullResult.confidence > 0.7);

    const sparse = new PhaseNarrativeBuilder({
      phases: [
        { phase: 50, name: 'A', problem: 'x', action: 'y', result: 'z', downstreamChange: 'w' },
        { phase: 51, name: 'B', problem: 'x', action: 'y', result: 'z', downstreamChange: 'w' },
      ],
      links: [],
    });
    const sparseResult = sparse.buildNarrative();
    assert.ok(sparseResult.confidence < fullResult.confidence);
  });

  it('includes problem/action/result/downstream for each phase', () => {
    const result = buildPhaseNarrative(21, 21);
    assert.ok(result.narrative.includes('Problem:'));
    assert.ok(result.narrative.includes('Action:'));
    assert.ok(result.narrative.includes('Result:'));
    assert.ok(result.narrative.includes('Led to:'));
  });

  it('formats for injection as plain narrative text', () => {
    const result = buildPhaseNarrative();
    const text = formatPhaseNarrative(result);
    assert.ok(text.startsWith('[Phase Causal Narrative]'));
    assert.ok(text.includes('Phase 21'));
  });

  it('respects token budget', () => {
    const builder = new PhaseNarrativeBuilder({ maxTokenBudget: 50 });
    const result = builder.buildNarrative();
    assert.ok(result.narrative.length < 250);
  });

  it('handles single phase', () => {
    const builder = new PhaseNarrativeBuilder({
      phases: [
        { phase: 99, name: 'Solo', problem: 'x', action: 'y', result: 'z', downstreamChange: 'w' },
      ],
      links: [],
    });
    const result = builder.buildNarrative();
    assert.equal(result.phases.length, 1);
    assert.equal(result.links.length, 0);
    assert.equal(result.confidence, 0.5);
  });

  it('handles empty phases', () => {
    const builder = new PhaseNarrativeBuilder({ phases: [], links: [] });
    const result = builder.buildNarrative();
    assert.equal(result.phases.length, 0);
    assert.equal(result.confidence, 0);
  });
});

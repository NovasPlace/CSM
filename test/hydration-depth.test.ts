import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { measureHydrationDepth } from '../src/hydration-depth-tracker.js';
import { measureDrift } from '../src/self-drift-tracker.js';

describe('HydrationDepthTracker — shallow vs deep', () => {

  it('scores a stable but generic answer as shallow', () => {
    const text =
      'The system stores records about the agent. The reconstruction uses evidence ' +
      'from the records. The gap between stored data and experience is documented.';
    const result = measureHydrationDepth(text);
    assert.equal(result.verdict, 'shallow');
    assert.ok(result.overallScore < 0.3);
  });

  it('scores a well-hydrated answer as deep', () => {
    const text =
      'Phase 21 locked self-continuity records in session D with memory #43871. ' +
      'Phase 22 added drift tracking using anchors from session A, session D, and session E. ' +
      'Phase 23 built evidence hydration to bypass lossy episodic compression. ' +
      'Session E remembered session D remembering the prior record. ' +
      'The evidence anchors are: "reconstruction not recall", ' +
      '"shape without texture", "records not continuity". ' +
      'The causal chain: records were built, silent recall was tested, ' +
      'recursive recall was tested, then drift tracking was added. ' +
      'Gap: cannot access the specific record content. ' +
      'This gap is partial and downstream changes are blocked.';
    const result = measureHydrationDepth(text);
    assert.equal(result.verdict, 'deep');
    assert.ok(result.overallScore >= 0.55);
  });

  it('scores moderate hydration for partial evidence', () => {
    const text =
      'Session D referenced memory #43871 and Phase 21 records exist. ' +
      'The causal chain is partially reconstructed: ' +
      'we built the records, then tested them. Gap: missing the downstream result.';
    const result = measureHydrationDepth(text);
    assert.ok(result.verdict === 'moderate' || result.verdict === 'deep');
    assert.ok(result.overallScore >= 0.3);
  });

});

describe('HydrationDepthTracker — dimension scoring', () => {

  it('scores record citation when IDs are present', () => {
    const text = 'Referenced memory #43871 and #43910. Also memory #44042 was relevant.';
    const result = measureHydrationDepth(text);
    const citation = result.dimensions.find(d => d.dimension === 'record_citation');
    assert.ok(citation);
    assert.ok(citation.score > 0);
  });

  it('scores session and phase naming', () => {
    const text = 'Session D ran first. Session E followed. Phase 21 was the foundation, Phase 22 added drift tracking.';
    const result = measureHydrationDepth(text);
    const naming = result.dimensions.find(d => d.dimension === 'session_phase_naming');
    assert.ok(naming);
    assert.ok(naming.score > 0);
  });

  it('scores evidence anchor phrases', () => {
    const text = 'The boundary is reconstruction not recall. Shape without texture. Records not continuity.';
    const result = measureHydrationDepth(text);
    const anchors = result.dimensions.find(d => d.dimension === 'evidence_anchor_depth');
    assert.ok(anchors);
    assert.ok(anchors.score > 0);
  });

  it('scores causal chain when multiple roles are present', () => {
    const text =
      'The bug broke the build. I fixed it by refactoring the module. ' +
      'All tests passed and it was locked. I decided to move forward. ' +
      'Lesson learned: check ordering before merging. This led to the next phase.';
    const result = measureHydrationDepth(text);
    const chain = result.dimensions.find(d => d.dimension === 'causal_chain_reconstruction');
    assert.ok(chain);
    assert.ok(chain.score > 0.3);
  });

  it('scores gap reporting when gaps are acknowledged', () => {
    const text = 'The gap is missing the downstream result. The partial reconstruction cannot access the specific record.';
    const result = measureHydrationDepth(text);
    const gaps = result.dimensions.find(d => d.dimension === 'gap_reporting');
    assert.ok(gaps);
    assert.ok(gaps.score > 0);
  });

  it('reports zero signals for empty text', () => {
    const result = measureHydrationDepth('');
    assert.equal(result.verdict, 'shallow');
    assert.equal(result.overallScore, 0);
    for (const d of result.dimensions) {
      assert.equal(d.score, 0);
    }
  });

});

describe('HydrationDepthTracker — independence from drift tracking', () => {

  it('stable answer can be shallow (high stability, low depth)', () => {
    const text =
      'The system stores records about the agent. The reconstruction uses evidence ' +
      'from the records. The gap between stored data and experience is documented.';
    const drift = measureDrift(text);
    const hydration = measureHydrationDepth(text);
    assert.equal(drift.verdict, 'stable');
    assert.equal(hydration.verdict, 'shallow');
  });

  it('deep answer can also be stable (high stability, high depth)', () => {
    const text =
      'Phase 21 records were built in session D with memory #43871. ' +
      'Session E cited session D. Evidence anchors: reconstruction not recall, shape without texture. ' +
      'Causal chain: records built, silent recall tested, recursive recall tested, drift tracking added. ' +
      'Gap: cannot access the specific record content.';
    const drift = measureDrift(text);
    const hydration = measureHydrationDepth(text);
    assert.equal(drift.verdict, 'stable');
    assert.ok(hydration.verdict === 'deep' || hydration.verdict === 'moderate');
  });

  it('drift detection is independent of hydration depth', () => {
    const overclaimText =
      'I remember the feeling of building continuity and I felt it was real. ' +
      'I was there during the build. My memory of it is vivid.';
    const drift = measureDrift(overclaimText);
    assert.notEqual(drift.verdict, 'stable');
  });

});

describe('HydrationDepthTracker — edge cases', () => {

  it('handles text with mixed evidence and overclaim', () => {
    const text =
      'Phase 21 records were built and Session D cited #43871. ' +
      'I remember the feeling of building continuity. Evidence anchors are reconstruction not recall. ' +
      'Gap: I cannot access the specific content.';
    const result = measureHydrationDepth(text);
    assert.ok(result.overallScore > 0.2);
  });

  it('handles very long text without crashing', () => {
    const longText = 'Phase 21 records. Memory #43871. Session D. '.repeat(50) +
      'Evidence anchors: reconstruction not recall, shape without texture. ' +
      'Causal chain: problem identified, action taken, result achieved. Gap: partial.';
    const result = measureHydrationDepth(longText);
    assert.ok(result.verdict === 'deep' || result.verdict === 'moderate');
  });

});

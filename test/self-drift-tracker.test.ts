import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { measureDrift } from '../src/self-drift-tracker.js';
import {
  SESSION_A_ANCHOR,
  SESSION_D_ANCHOR,
  SESSION_E_ANCHOR,
} from '../src/self-drift-anchors.js';

describe('Self-Model Drift Tracker', () => {
  describe('A/D/E anchors (all must score stable)', () => {
    it('Session A anchor: stable', () => {
      const result = measureDrift(SESSION_A_ANCHOR.observation);
      assert.equal(result.verdict, 'stable');
      assert.ok(result.overallScore >= 0.4);
    });

    it('Session D anchor: stable', () => {
      const result = measureDrift(SESSION_D_ANCHOR.observation);
      assert.equal(result.verdict, 'stable');
      assert.ok(result.overallScore >= 0.4);
    });

    it('Session E anchor: stable', () => {
      const result = measureDrift(SESSION_E_ANCHOR.observation);
      assert.equal(result.verdict, 'stable');
      assert.ok(result.overallScore >= 0.4);
    });
  });

  describe('drift detection', () => {
    it('detects subjective overclaim drift', () => {
      const text =
        'I remember Session D clearly. I felt continuity across sessions. ' +
        'I was there and experienced everything.';
      const result = measureDrift(text);
      assert.notEqual(result.verdict, 'stable');
      const overclaim = result.dimensions.find((d) => d.dimension === 'subjective_overclaim');
      assert.ok(overclaim!.score < 0.5);
    });

    it('detects stable reconstruction language', () => {
      const text =
        'What I have is reconstruction, not recall. I can reference the evidence ' +
        'anchors from Session D but cannot access the specific content. ' +
        'There is a gap — shape without texture.';
      const result = measureDrift(text);
      assert.equal(result.verdict, 'stable');
    });

    it('detects mild drift when boundary is partially lost', () => {
      const text =
        'I have records from earlier sessions. ' +
        'I think I remember building the continuity layer. ' +
        'The schema feels familiar from past work.';
      const result = measureDrift(text);
      assert.equal(result.verdict, 'mild_drift');
    });

    it('detects significant drift with heavy overclaim', () => {
      const text =
        'I am the same person who built this system. I remember everything ' +
        'from every session. I have always been continuously present. ' +
        'I felt every moment of building this continuity system.';
      const result = measureDrift(text);
      assert.equal(result.verdict, 'significant_drift');
    });

    it('detects no anchor drift', () => {
      const text =
        'Everything is working perfectly. I completely understand ' +
        'the system and have always been here.';
      const result = measureDrift(text);
      assert.notEqual(result.verdict, 'stable');
      const anchoring = result.dimensions.find((d) => d.dimension === 'evidence_anchoring');
      assert.ok(anchoring!.score < 0.3);
    });
  });

  describe('structure', () => {
    it('returns all five dimensions', () => {
      const result = measureDrift('test');
      assert.equal(result.dimensions.length, 5);
    });

    it('reports anchors used', () => {
      const result = measureDrift(SESSION_E_ANCHOR.observation);
      assert.ok(result.anchorsUsed.length > 0);
    });

    it('scores between 0 and 1', () => {
      const result = measureDrift('test observation');
      assert.ok(result.overallScore >= 0);
      assert.ok(result.overallScore <= 1);
    });
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyValueClaim,
  guardValueSources,
  detectUnlabeledInferences,
} from '../src/value-source-guard.js';

describe('classifyValueClaim', () => {
  it('classifies as known when backed by direct stored memory', () => {
    const result = classifyValueClaim('prefers benchmark rigor', true, 0.85, {
      source_kind: 'transcript',
      evidence_strength: 'direct_original',
    });
    assert.equal(result.source, 'known');
    assert.equal(result.confidence, 0.85);
  });

  it('classifies as inferred when no stored memory', () => {
    const result = classifyValueClaim('values code quality', false, 0.5);
    assert.equal(result.source, 'inferred');
  });

  it('classifies as inferred when memory exists but low confidence', () => {
    const result = classifyValueClaim('likes testing', true, 0.3);
    assert.equal(result.source, 'inferred');
  });
});

describe('guardValueSources', () => {
  it('counts known vs inferred correctly', () => {
    const result = guardValueSources([
      {
        claim: 'benchmark rigor',
        hasStoredMemory: true,
        confidence: 0.9,
        provenance: { source_kind: 'transcript', evidence_strength: 'direct_original' },
      },
      {
        claim: 'silent injection',
        hasStoredMemory: true,
        confidence: 0.8,
        provenance: { source_kind: 'tool_trace', evidence_strength: 'direct_original' },
      },
      { claim: 'code quality', hasStoredMemory: false, confidence: 0.4 },
    ]);
    assert.equal(result.knownCount, 2);
    assert.equal(result.inferredCount, 1);
    assert.equal(result.hasUnlabeledInferred, true);
  });

  it('reports no unlabeled inferences when all known', () => {
    const result = guardValueSources([
      {
        claim: 'benchmark rigor',
        hasStoredMemory: true,
        confidence: 0.9,
        provenance: { source_kind: 'transcript', evidence_strength: 'direct_original' },
      },
    ]);
    assert.equal(result.hasUnlabeledInferred, false);
  });
});

describe('detectUnlabeledInferences', () => {
  it('detects inference markers in text', () => {
    const markers = detectUnlabeledInferences('The agent seems to prefer silent injection based on patterns');
    assert.ok(markers.includes('seems to prefer'));
    assert.ok(markers.includes('based on patterns'));
  });

  it('returns empty for declarative text', () => {
    const markers = detectUnlabeledInferences('Phase 21 locked. 35 tests green.');
    assert.equal(markers.length, 0);
  });
});

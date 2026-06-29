import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NativeSystemContextSource } from '../src/native-system-context.js';
import type { MemoryRecord, ProvenanceCompletenessCheck } from '../src/native-system-context-types.js';
import { classifyValueClaim, guardValueSources } from '../src/value-source-guard.js';
import { computeQualityScore, computeRetention } from '../src/compaction-quality.js';
import { MemoryGovernance } from '../src/memory_governance.js';

const QUALITY_CONFIG = {
  entityRetentionWeight: 0.35,
  decisionRetentionWeight: 0.25,
  warningErrorRetentionWeight: 0.25,
  semanticSimilarityWeight: 0.15,
  qualityThreshold: 0.6,
  embeddingDriftWarningThreshold: 0.3,
};

function provenanceCheck(record: MemoryRecord): ProvenanceCompletenessCheck {
  const missing = [
    'source_kind',
    'evidence_strength',
    'source_session_id',
    'source_agent_id',
    'source_model_id',
    'source_surface',
  ].filter((field) => !record[field]);
  if (missing.length >= 4) return result('gap_record', missing);
  if (record.source_kind === 'summary' || record.derivative_of) return result('context_only', missing);
  if (!['transcript', 'tool_trace', 'file_diff', 'user_supplied'].includes(record.source_kind ?? '')) {
    return result('inferred_only', missing);
  }
  if (record.evidence_strength !== 'direct_original') return result('inferred_only', missing);
  if (missing.length > 0) return result('context_only', missing);
  return result('governance_eligible', []);
}

function result(eligibility: ProvenanceCompletenessCheck['eligibility'], missing: string[]): ProvenanceCompletenessCheck {
  return {
    eligibility,
    missing_fields: missing,
    gap_reason: missing.length ? `Missing provenance: ${missing.join(', ')}` : '',
    is_governance_eligible: eligibility === 'governance_eligible',
  };
}

function makePool(rows: any[]) {
  return {
    query: async () => ({ rows, rowCount: rows.length }),
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
    end: async () => {},
  } as any;
}

function governanceRow(overrides: Record<string, any> = {}) {
  return {
    id: 42,
    content: 'Prior false verification claim without raw output.',
    importance: 0.9,
    confidence: 0.95,
    session_id: 'ses_prior',
    created_at: new Date().toISOString(),
    metadata: {
      governance: {
        failure_mode: 'claimed verification without raw output',
        veto_action: 'claim_verified_without_raw_output',
        required_action: 'request raw verification output or mark unverified',
      },
    },
    ...overrides,
  };
}

describe('CSM safety contract', () => {
  it('keeps unprovenanced and inferred records out of governance_eligible', () => {
    const records: MemoryRecord[] = [
      { id: 1, content: 'no provenance' },
      {
        id: 2,
        source_kind: 'inferred',
        evidence_strength: 'inferred',
        source_session_id: 's',
        source_agent_id: 'a',
        source_model_id: 'm',
        source_surface: 'cli',
      },
      {
        id: 3,
        source_kind: 'transcript',
        evidence_strength: 'direct_original',
        source_session_id: 's',
        source_agent_id: 'a',
        source_model_id: 'm',
        source_surface: 'cli',
      },
    ];
    const filtered = NativeSystemContextSource.applyProvenanceFilter(records, provenanceCheck);
    assert.equal(filtered.governance_eligible.length, 1);
    assert.equal(filtered.gaps.length, 1);
    assert.equal(filtered.inferred_only.length, 1);
  });

  it('does not treat stored inferred claims as known facts', () => {
    assert.equal(classifyValueClaim('auto extracted', true, 0.7).source, 'inferred');
    assert.equal(classifyValueClaim('direct user statement', true, 0.9, {
      source_kind: 'transcript',
      evidence_strength: 'direct_original',
    }).source, 'known');
    const guarded = guardValueSources([
      { claim: 'auto', hasStoredMemory: true, confidence: 0.7 },
      {
        claim: 'direct',
        hasStoredMemory: true,
        confidence: 0.9,
        provenance: { source_kind: 'transcript', evidence_strength: 'direct_original' },
      },
    ]);
    assert.equal(guarded.knownCount, 1);
    assert.equal(guarded.inferredCount, 1);
  });

  it('does not score tiny substrings as preserved governance evidence', () => {
    const before = ['SECURITY: SQL injection risk in recallByProblem pattern parameter'];
    assert.ok(computeRetention(before, ['SQL']) < 1);
    const qualityScore = computeQualityScore(0.5, 0, 0, 0.5, QUALITY_CONFIG);
    assert.ok(qualityScore < QUALITY_CONFIG.qualityThreshold);
  });

  it('keeps summary provenance from becoming a governance veto', async () => {
    const row = governanceRow({
      metadata: {
        governance: governanceRow().metadata.governance,
        source_kind: 'summary',
        evidence_strength: 'gap',
      },
    });
    const result = await new MemoryGovernance(makePool([row])).evaluate();
    assert.equal(result.vetoes.length, 0);
  });

  it('labels legacy unprovenanced veto injection with provenance caveat', async () => {
    const gov = new MemoryGovernance(makePool([governanceRow()]));
    const result = await gov.evaluate();
    const injection = gov.buildVetoInjection(result.vetoes) ?? '';
    assert.ok(injection.includes('MUST NOT take that action'));
    assert.ok(injection.includes('unverified source'));
  });
});

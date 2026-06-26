import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import {
  extractEntities,
  extractDecisions,
  extractWarningsErrors,
  computeRetention,
  computeCompressionRatio,
  computeQualityScore,
  cosineSimilarity,
} from '../dist/compaction-quality.js';
import type { CompactionQualityConfig } from '../dist/types.js';

const QCFG: CompactionQualityConfig = {
  entityRetentionWeight: 0.35,
  decisionRetentionWeight: 0.25,
  warningErrorRetentionWeight: 0.25,
  semanticSimilarityWeight: 0.15,
  qualityThreshold: 0.5,
};

describe('extractEntities', () => {
  it('extracts file paths', () => {
    const entities = extractEntities('Fixed bug in src/tui.ts and lib/core.ts');
    ok(entities.includes('src/tui.ts'));
    ok(entities.includes('lib/core.ts'));
  });

  it('extracts function names', () => {
    const entities = extractEntities('Called createContextCompactor() and getPool()');
    ok(entities.length > 0, `Expected some entities, got: ${JSON.stringify(entities)}`);
    ok(entities.some(e => e.includes('ContextCompactor') || e.includes('Compactor')), `Expected function-like entity, got: ${JSON.stringify(entities)}`);
  });

  it('extracts class names', () => {
    const entities = extractEntities('Used class ContextCompiler and Database');
    ok(entities.length > 0, `Expected some entities, got: ${JSON.stringify(entities)}`);
  });

  it('extracts config keys', () => {
    const entities = extractEntities('Set workingMemoryWindow and maxOutputChars');
    ok(entities.length > 0, `Expected some entities, got: ${JSON.stringify(entities)}`);
  });

  it('extracts error names with codes', () => {
    const entities = extractEntities('Got error ECONNREFUSED and foreign key constraint violation');
    ok(entities.length > 0, `Expected some entities, got: ${JSON.stringify(entities)}`);
  });

  it('returns empty for no entities', () => {
    const entities = extractEntities('hello world this is plain text');
    strictEqual(entities.length, 0);
  });
});

describe('extractDecisions', () => {
  it('extracts decision patterns', () => {
    const decisions = extractDecisions('Decision: use SQLite instead of PostgreSQL. Decided to skip phase 4. We decided: use REST API');
    ok(decisions.length >= 1, `Expected at least 1 decision, got ${decisions.length}: ${JSON.stringify(decisions)}`);
  });

  it('extracts "we chose" patterns', () => {
    const decisions = extractDecisions('We chose the async approach for performance');
    ok(decisions.length >= 1);
  });

  it('returns empty for no decisions', () => {
    const decisions = extractDecisions('The weather is nice today');
    strictEqual(decisions.length, 0);
  });
});

describe('extractWarningsErrors', () => {
  it('extracts error patterns', () => {
    const items = extractWarningsErrors('ERROR: connection failed. Error: timeout exceeded');
    ok(items.length >= 1, `Expected at least 1 error, got ${items.length}: ${JSON.stringify(items)}`);
  });

  it('extracts warning patterns', () => {
    const items = extractWarningsErrors('WARNING: deprecated API. Warning: low memory');
    ok(items.length >= 1, `Expected at least 1 warning, got ${items.length}: ${JSON.stringify(items)}`);
  });

  it('extracts deprecation and rollback notes', () => {
    const items = extractWarningsErrors('Deprecated: use newMethod(). Rollback: revert to v1. SECURITY: sanitize input');
    ok(items.some(i => i.includes('Deprecated') || i.includes('deprecated')));
    ok(items.some(i => i.includes('Rollback') || i.includes('rollback')));
    ok(items.some(i => i.includes('SECURITY') || i.includes('security')));
  });

  it('returns empty for no warnings or errors', () => {
    const items = extractWarningsErrors('Everything is fine');
    strictEqual(items.length, 0);
  });
});

describe('computeRetention', () => {
  it('returns 1.0 when all items retained', () => {
    const retention = computeRetention(['a', 'b', 'c'], ['a', 'b', 'c']);
    strictEqual(retention, 1.0);
  });

  it('returns 0.0 when no items retained', () => {
    const retention = computeRetention(['a', 'b', 'c'], ['x', 'y']);
    strictEqual(retention, 0.0);
  });

  it('returns partial retention', () => {
    const retention = computeRetention(['a', 'b', 'c'], ['a', 'x']);
    ok(Math.abs(retention - 1/3) < 0.01);
  });

  it('returns 1.0 for empty before list', () => {
    const retention = computeRetention([], ['a', 'b']);
    strictEqual(retention, 1.0);
  });
});

describe('computeCompressionRatio', () => {
  it('computes ratio correctly', () => {
    const ratio = computeCompressionRatio(1000, 300);
    ok(Math.abs(ratio - 0.7) < 0.01);
  });

  it('returns 0 for no compression', () => {
    const ratio = computeCompressionRatio(1000, 1000);
    strictEqual(ratio, 0);
  });

  it('handles zero input tokens', () => {
    const ratio = computeCompressionRatio(0, 0);
    strictEqual(ratio, 0);
  });
});

describe('computeQualityScore', () => {
  it('computes perfect score', () => {
    const score = computeQualityScore(1.0, 1.0, 1.0, 1.0, QCFG);
    ok(Math.abs(score - 1.0) < 0.01);
  });

  it('computes zero score', () => {
    const score = computeQualityScore(0.0, 0.0, 0.0, 0.0, QCFG);
    strictEqual(score, 0);
  });

  it('weights entity retention highest', () => {
    const scoreHighEntity = computeQualityScore(1.0, 0.0, 0.0, 0.0, QCFG);
    const scoreHighDecision = computeQualityScore(0.0, 1.0, 0.0, 0.0, QCFG);
    ok(scoreHighEntity > scoreHighDecision);
  });

  it('weights warning/error same as decision', () => {
    const scoreWarning = computeQualityScore(0.0, 0.0, 1.0, 0.0, QCFG);
    const scoreDecision = computeQualityScore(0.0, 1.0, 0.0, 0.0, QCFG);
    ok(Math.abs(scoreWarning - scoreDecision) < 0.001);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const sim = cosineSimilarity([1, 2, 3], [1, 2, 3]);
    ok(Math.abs(sim - 1.0) < 0.01);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    const sim = cosineSimilarity([1, 0], [0, 1]);
    ok(Math.abs(sim) < 0.01);
  });

  it('returns 0 for mismatched lengths', () => {
    const sim = cosineSimilarity([1, 2], [1, 2, 3]);
    strictEqual(sim, 0);
  });
});

describe('compaction quality integration', () => {
  it('compacted memory preserves file paths', () => {
    const before = 'Fixed bug in src/tui.ts and lib/core.ts by updating createContextCompactor';
    const after = 'Fixed bug in src/tui.ts, lib/core.ts; updated compactor';
    const entitiesBefore = extractEntities(before);
    const entitiesAfter = extractEntities(after);
    const retention = computeRetention(entitiesBefore, entitiesAfter);
    ok(retention >= 0.5, `Expected entity retention >= 0.5, got ${retention}`);
  });

  it('compacted memory preserves function names', () => {
    const before = 'Called createContextCompactor() and then getPool() to connect';
    const after = 'Called createContextCompactor(), getPool() to connect';
    const entitiesBefore = extractEntities(before);
    const entitiesAfter = extractEntities(after);
    const retention = computeRetention(entitiesBefore, entitiesAfter);
    ok(retention >= 0.9, `Expected entity retention >= 0.9, got ${retention}`);
  });

  it('compacted memory preserves errors/warnings', () => {
    const before = 'ERROR: connection failed. WARNING: deprecated API. Also some normal text here.';
    const after = 'ERROR: connection failed. WARNING: deprecated API. [compacted]';
    const warningsBefore = extractWarningsErrors(before);
    const warningsAfter = extractWarningsErrors(after);
    const retention = computeRetention(warningsBefore, warningsAfter);
    ok(retention >= 0.9, `Expected warning/error retention >= 0.9, got ${retention}`);
  });

  it('compacted memory preserves decisions', () => {
    const before = 'Decision: use SQLite instead of PostgreSQL for local dev';
    const after = 'Decision: use SQLite instead of PostgreSQL';
    const decisionsBefore = extractDecisions(before);
    const decisionsAfter = extractDecisions(after);
    const retention = computeRetention(decisionsBefore, decisionsAfter);
    ok(retention >= 0.5, `Expected decision retention >= 0.5, got ${retention}`);
  });

  it('compacted memory does not drop deprecation/rollback/security notes', () => {
    const before = 'Deprecated: use newMethod(). Rollback: revert to v1. SECURITY: sanitize input.';
    const after = 'Deprecated: use newMethod(). Rollback: revert to v1. SECURITY: sanitize input. [session ended]';
    const warningsBefore = extractWarningsErrors(before);
    const warningsAfter = extractWarningsErrors(after);
    const retention = computeRetention(warningsBefore, warningsAfter);
    strictEqual(retention, 1.0);
  });

  it('quality score drops below threshold when entities are lost', () => {
    const score = computeQualityScore(0.1, 0.2, 0.3, 0.4, QCFG);
    ok(score < QCFG.qualityThreshold, `Expected score < ${QCFG.qualityThreshold}, got ${score}`);
  });

  it('quality score passes threshold when entities are retained', () => {
    const score = computeQualityScore(0.8, 0.8, 0.8, 0.8, QCFG);
    ok(score >= QCFG.qualityThreshold, `Expected score >= ${QCFG.qualityThreshold}, got ${score}`);
  });
});

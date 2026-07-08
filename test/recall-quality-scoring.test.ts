import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreMetrics,
  type RecallMetrics,
  type RecallQualityGrade,
} from '../src/recall-quality-tool.js';

function makeMetrics(overrides: Partial<RecallMetrics> = {}): RecallMetrics {
  return {
    totalEvents: 0,
    surfacesFired: [],
    surfacesMissing: [],
    surfaceCount: 0,
    top3Rate: 0,
    mrr: 0,
    emptyResultRate: 0,
    searchRecallRate: 0,
    freshRate: 0,
    staleRate: 0,
    duplicateRate: 0,
    textFallbackRate: 0,
    vectorHealthRate: 0,
    lowResultRate: 0,
    sourceDistribution: {},
    nullMemoryIdRate: 0,
    graphEventCount: 0,
    dialect: 'pg',
    ...overrides,
  };
}

describe('Phase 6D: Recall Quality Scoring', () => {
  it('empty telemetry produces unknown, not degraded', () => {
    const score = scoreMetrics(makeMetrics({ totalEvents: 0 }));
    assert.equal(score.grade, 'unknown');
    assert.equal(score.confidence, 0);
    assert.ok(score.reasons.some(r => r.includes('No recall events')));
    assert.ok(score.recommendations.length > 0);
  });

  it('low-traffic window does not fail as degraded', () => {
    const score = scoreMetrics(makeMetrics({
      totalEvents: 5,
      surfaceCount: 1,
      surfacesFired: ['context_recall'],
      sourceDistribution: { context_recall: 5 },
    }));
    assert.equal(score.grade, 'sparse_data');
    assert.ok(score.reasons.some(r => r.includes('5 recall events')));
    assert.ok(score.recommendations.some(r => r.includes('Sparse data is not a quality problem')));
  });

  it('empty_result with nullable memory_id is accepted (not a failure)', () => {
    const score = scoreMetrics(makeMetrics({
      totalEvents: 100,
      surfaceCount: 4,
      surfacesFired: ['search', 'context_recall', 'empty_result', 'list'],
      sourceDistribution: { search: 60, context_recall: 20, empty_result: 10, list: 10 },
      nullMemoryIdRate: 10,
      emptyResultRate: 10,
      vectorHealthRate: 90,
    }));
    assert.notEqual(score.grade, 'degraded');
    assert.ok(score.confidence > 0);
  });

  it('graph recall absent because no links exist is advisory, not failure', () => {
    const score = scoreMetrics(makeMetrics({
      totalEvents: 100,
      surfaceCount: 3,
      surfacesFired: ['search', 'context_recall', 'list'],
      sourceDistribution: { search: 50, context_recall: 30, list: 20 },
      graphEventCount: 0,
      vectorHealthRate: 90,
    }));
    assert.notEqual(score.grade, 'degraded');
    assert.ok(score.reasons.some(r => r.includes('No graph recall events')));
    assert.ok(score.recommendations.some(r => r.includes('Graph recall unavailable or unused')));
  });

  it('SQLite text-only path is scored as sparse_data', () => {
    const score = scoreMetrics(makeMetrics({
      totalEvents: 500,
      dialect: 'sqlite',
    }));
    assert.equal(score.grade, 'sparse_data');
    assert.ok(score.reasons.some(r => r.includes('SQLite')));
    assert.ok(score.recommendations.some(r => r.includes('Switch to PostgreSQL')));
  });

  it('PostgreSQL vector path with healthy metrics scores as healthy', () => {
    const score = scoreMetrics(makeMetrics({
      totalEvents: 200,
      surfaceCount: 5,
      surfacesFired: ['search', 'list', 'context_recall', 'graph', 'vector_only'],
      sourceDistribution: { search: 100, list: 30, context_recall: 40, graph: 20, vector_only: 10 },
      top3Rate: 65,
      mrr: 0.45,
      emptyResultRate: 5,
      textFallbackRate: 2,
      vectorHealthRate: 90,
      graphEventCount: 20,
    }));
    assert.equal(score.grade, 'healthy');
    assert.ok(score.confidence > 0.5);
  });

  it('text fallback overuse produces needs_attention', () => {
    const score = scoreMetrics(makeMetrics({
      totalEvents: 200,
      surfaceCount: 3,
      surfacesFired: ['search', 'text_fallback', 'text_only'],
      sourceDistribution: { search: 60, text_fallback: 100, text_only: 40 },
      textFallbackRate: 70,
      vectorHealthRate: 90,
    }));
    assert.equal(score.grade, 'needs_attention');
    assert.ok(score.reasons.some(r => r.includes('High text fallback rate')));
    assert.ok(score.recommendations.some(r => r.includes('vector search degradation')));
  });

  it('high empty_result rate produces needs_attention', () => {
    const score = scoreMetrics(makeMetrics({
      totalEvents: 200,
      surfaceCount: 3,
      surfacesFired: ['search', 'empty_result', 'context_recall'],
      sourceDistribution: { search: 50, empty_result: 120, context_recall: 30 },
      emptyResultRate: 60,
      vectorHealthRate: 90,
    }));
    assert.equal(score.grade, 'needs_attention');
    assert.ok(score.reasons.some(r => r.includes('High empty-result rate')));
  });

  it('low vector health produces needs_attention', () => {
    const score = scoreMetrics(makeMetrics({
      totalEvents: 200,
      surfaceCount: 4,
      surfacesFired: ['search', 'list', 'context_recall', 'vector_only'],
      sourceDistribution: { search: 100, list: 30, context_recall: 40, vector_only: 30 },
      vectorHealthRate: 30,
    }));
    assert.equal(score.grade, 'needs_attention');
    assert.ok(score.reasons.some(r => r.includes('Low vector health')));
  });

  it('low confidence (30-49 events) with healthy metrics downgrades to sparse_data', () => {
    const score = scoreMetrics(makeMetrics({
      totalEvents: 45,
      surfaceCount: 4,
      surfacesFired: ['search', 'list', 'context_recall', 'graph'],
      sourceDistribution: { search: 15, list: 10, context_recall: 10, graph: 10 },
      graphEventCount: 10,
      vectorHealthRate: 90,
    }));
    assert.equal(score.grade, 'sparse_data');
    assert.ok(score.reasons.some(r => r.includes('Low confidence')));
  });

  it('all 8 recall surfaces represented gives healthy if no other issues', () => {
    const allSources = ['search', 'list', 'context_recall', 'graph', 'vector_only', 'text_only', 'text_fallback', 'empty_result'];
    const score = scoreMetrics(makeMetrics({
      totalEvents: 300,
      surfaceCount: 8,
      surfacesFired: allSources,
      sourceDistribution: Object.fromEntries(allSources.map(s => [s, 30])),
      emptyResultRate: 5,
      textFallbackRate: 5,
      vectorHealthRate: 85,
      graphEventCount: 30,
    }));
    assert.equal(score.grade, 'healthy');
    assert.ok(score.confidence > 0.5);
  });

  it('scoring never mutates input metrics', () => {
    const metrics = makeMetrics({ totalEvents: 100, surfaceCount: 3 });
    const before = JSON.stringify(metrics);
    scoreMetrics(metrics);
    const after = JSON.stringify(metrics);
    assert.equal(before, after, 'scoreMetrics must not mutate its input');
  });

  it('all valid grades are accepted by the type system', () => {
    const grades: RecallQualityGrade[] = ['healthy', 'sparse_data', 'needs_attention', 'degraded', 'unknown'];
    assert.equal(grades.length, 5);
  });
});

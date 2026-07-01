import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUALITY_SCORING_VERSION,
  getScoreBand,
  recencyScore,
  scoreMemory,
  summarizeScores,
} from '../dist/quality-scoring.js';

describe('quality scoring', () => {
  it('adds structural bonuses into the final score', () => {
    const baseline = scoreMemory({
      contentLength: 120,
      hasTitle: false,
      hasSourceSession: false,
      hasProjectId: false,
      hasMemoryType: false,
      hasEmbedding: false,
      importance: 0,
      confidence: 0,
      recency: 0,
      duplicateStatus: 'active',
      retrievalCount: 0,
    });
    const enriched = scoreMemory({
      contentLength: 120,
      hasTitle: true,
      hasSourceSession: true,
      hasProjectId: true,
      hasMemoryType: true,
      hasEmbedding: true,
      importance: 0,
      confidence: 0,
      recency: 0,
      duplicateStatus: 'active',
      retrievalCount: 0,
    });

    assert.equal(baseline.score, 0);
    assert.ok(Math.abs(enriched.score - 0.55) < 1e-9);
    assert.equal(enriched.band, 'medium');
    assert.equal(enriched.features.title, 0.15);
    assert.equal(enriched.features.memoryType, 0.05);
    assert.equal(enriched.scoringVersion, QUALITY_SCORING_VERSION);
  });

  it('caps retrieval bonus at the configured maximum', () => {
    const result = scoreMemory({
      contentLength: 120,
      hasTitle: false,
      hasSourceSession: false,
      hasProjectId: false,
      hasMemoryType: false,
      hasEmbedding: false,
      importance: 0,
      confidence: 0,
      recency: 0,
      duplicateStatus: 'active',
      retrievalCount: 100,
    });

    assert.equal(result.features.retrieval, 0.15);
    assert.equal(result.score, 0.15);
  });

  it('scores recency bands deterministically', () => {
    const now = new Date('2026-07-01T12:00:00.000Z');
    assert.equal(recencyScore('2026-07-01T11:00:00.000Z', now), 1);
    assert.equal(recencyScore('2026-06-29T12:00:00.000Z', now), 0.8);
    assert.equal(recencyScore('2026-06-20T12:00:00.000Z', now), 0.6);
    assert.equal(recencyScore('2026-04-01T12:00:00.000Z', now), 0.05);
  });

  it('returns a zero summary for empty score lists', () => {
    const summary = summarizeScores([]);
    assert.equal(summary.totalScores, 0);
    assert.equal(summary.avgScore, 0);
    assert.deepEqual(summary.bandCounts, {});
  });

  it('maps quality bands at the documented thresholds', () => {
    assert.equal(getScoreBand(0.7), 'high');
    assert.equal(getScoreBand(0.4), 'medium');
    assert.equal(getScoreBand(0.2), 'low');
    assert.equal(getScoreBand(0.19), 'very low');
  });
});

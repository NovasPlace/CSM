import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ArchiveCandidateReportBuilder } from '../src/archive-candidate-report.js';

function daysAgo(days: number) {
  return new Date(Date.now() - days * 86_400_000);
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    memory_type: 'episodic',
    content: '[modified] index.html',
    created_at: daysAgo(20),
    access_count: 0,
    superseded_by: null,
    quality_score: 0.3,
    quality_band: 'low',
    recall_count: 0,
    ...overrides,
  };
}

function db(rows: unknown[]) {
  return { getPool: () => ({ query: async () => ({ rows, rowCount: rows.length }) }) };
}

describe('ArchiveCandidateReportBuilder', () => {
  it('includes only safe archive candidates and excludes broad low-access rows', async () => {
    const builder = new ArchiveCandidateReportBuilder(db([
      row({ id: 1, memory_type: 'procedural', superseded_by: 9, content: 'Completed: Edit index.ts — 1 file(s) changed' }),
      row({ id: 2, memory_type: 'episodic', content: '[modified] index.html' }),
      row({ id: 3, memory_type: 'conversation', content: 'hey', quality_score: 0.4, quality_band: 'medium' }),
      row({ id: 4, memory_type: 'conversation', content: 'useful debugging note with enough substance to keep active', quality_score: 0.55, quality_band: 'medium', access_count: 1 }),
      row({ id: 5, memory_type: 'conversation', content: 'retry', superseded_by: 10, quality_score: 0.5, quality_band: 'medium' }),
    ]) as any);

    const report = await builder.build({ maxPerReason: 10 });

    assert.equal(report.reasonCounts.already_superseded_duplicate, 2);
    assert.equal(report.reasonCounts.tiny_type_specific_junk, 1);
    assert.equal(report.candidateCount, 3);
    assert.equal(report.overlapCount, 0);
    assert.equal(report.excludedCounts.lowAccess, 3);
    assert.equal(report.excludedCounts.mediumBandConversation, 1);
    assert.deepEqual(
      report.categories.tiny_type_specific_junk.samples.map((sample) => sample.memoryId),
      [2],
    );
    assert.deepEqual(
      report.categories.already_superseded_duplicate.samples.map((sample) => sample.reasonCode),
      ['already_superseded_duplicate', 'already_superseded_duplicate'],
    );
  });
});

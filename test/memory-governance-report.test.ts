import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryGovernanceReportBuilder } from '../src/memory-governance-report.js';

function daysAgo(days: number) {
  return new Date(Date.now() - days * 86_400_000);
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    memory_type: 'conversation',
    content: 'tiny old memory',
    created_at: daysAgo(60),
    accessed_at: daysAgo(60),
    access_count: 0,
    superseded_by: null,
    quality_score: 0.1,
    quality_band: 'very low',
    recall_count: 0,
    archived_at: null,
    archive_reason: null,
    ...overrides,
  };
}

function db(rows: unknown[]) {
  return { getPool: () => ({ query: async () => ({ rows, rowCount: rows.length }) }) };
}

describe('MemoryGovernanceReportBuilder', () => {
  it('builds read-only candidate buckets from score and access signals', async () => {
    const builder = new MemoryGovernanceReportBuilder(db([
      row({ id: 1, memory_type: 'conversation', quality_score: 0.1, quality_band: 'very low' }),
      row({ id: 2, memory_type: 'preference', quality_score: 0.5, quality_band: 'medium', created_at: daysAgo(90), accessed_at: daysAgo(40) }),
      row({ id: 3, memory_type: 'workspace', quality_score: 0.6, quality_band: 'medium', created_at: daysAgo(20), accessed_at: daysAgo(20) }),
      row({ id: 4, memory_type: 'procedural', superseded_by: 1, quality_score: null, quality_band: null }),
      row({ id: 5, memory_type: 'episodic', content: 'short', quality_score: 0.3, quality_band: 'low', created_at: daysAgo(20), accessed_at: daysAgo(20) }),
    ]) as any);

    const report = await builder.build({ maxPerCategory: 10, staleDays: 45 });

    assert.equal(report.scannedTotal, 5);
    assert.equal(report.activeMemories, 4);
    assert.equal(report.supersededMemories, 1);
    assert.equal(report.categoryCounts.lowQuality, 1);
    assert.equal(report.categoryCounts.stale, 2);
    assert.equal(report.categoryCounts.lowAccess, 4);
    assert.equal(report.categoryCounts.supersededDuplicates, 1);
    assert.equal(report.categoryCounts.typeSpecificJunk, 2);
    assert.equal(report.categories.supersededDuplicates.samples[0]?.supersededBy, 1);
  });

  it('excludes archived rows from candidate counts and shows archived summary', async () => {
    const builder = new MemoryGovernanceReportBuilder(db([
      row({ id: 1, memory_type: 'episodic', content: 'short', quality_score: 0.3, quality_band: 'low', created_at: daysAgo(20), accessed_at: daysAgo(20) }),
      row({ id: 2, memory_type: 'episodic', content: 'short junk', quality_score: 0.3, quality_band: 'low', created_at: daysAgo(20), accessed_at: daysAgo(20), archived_at: daysAgo(1), archive_reason: 'tiny_type_specific_junk' }),
      row({ id: 3, memory_type: 'procedural', superseded_by: 9, content: 'old dupe', quality_score: null, quality_band: null }),
      row({ id: 4, memory_type: 'procedural', superseded_by: 8, content: 'archived dupe', quality_score: null, quality_band: null, archived_at: daysAgo(1), archive_reason: 'already_superseded_duplicate' }),
    ]) as any);

    const report = await builder.build({ maxPerCategory: 10, staleDays: 45 });

    assert.equal(report.scannedTotal, 4);
    assert.equal(report.activeMemories, 1);
    assert.equal(report.supersededMemories, 2);
    assert.equal(report.archivedMemories, 2);
    assert.equal(report.archivedByReason['tiny_type_specific_junk'], 1);
    assert.equal(report.archivedByReason['already_superseded_duplicate'], 1);
    assert.equal(report.categoryCounts.typeSpecificJunk, 1);
    assert.equal(report.categoryCounts.supersededDuplicates, 1);
  });
});

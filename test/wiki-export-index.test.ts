import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderIndexPage, renderLogEntry } from '../dist/wiki-note-renderer.js';

function indexInput(overrides: Record<string, unknown> = {}) {
  return {
    totalNotes: 0,
    byCategory: {},
    byType: {},
    recentLessons: [],
    recentDecisions: [],
    recentKnowledge: [],
    entityHotlist: [],
    ...overrides,
  };
}

describe('renderIndexPage', () => {
  it('includes statistics and uses the index path', () => {
    const note = renderIndexPage(indexInput({
      totalNotes: 100,
      byCategory: { lessons: 30, memories: 70 },
      byType: { lesson: 30, episodic: 70 },
    }) as never);
    assert.ok(note.content.includes('Total notes: 100'));
    assert.ok(note.content.includes('lessons: 30'));
    assert.equal(note.path, 'index.md');
  });

  it('includes recent lessons with wikilinks', () => {
    const note = renderIndexPage(indexInput({
      totalNotes: 1,
      recentLessons: [{ id: 42, content: 'Important lesson', importance: 0.9, createdAt: new Date() }],
    }) as never);
    assert.ok(note.content.includes('[[mem-42]]'));
  });
});

describe('renderLogEntry', () => {
  it('produces timestamped export counts', () => {
    const entry = renderLogEntry({
      timestamp: '2026-07-15T23:00:00Z', mode: 'curated', notesCreated: 10,
      notesUpdated: 5, notesRemoved: 2, notesUnchanged: 100, totalEligible: 117,
    });
    for (const expected of [
      '## 2026-07-15T23:00:00Z', 'Mode: curated', 'Created: 10', 'Removed: 2',
    ]) assert.ok(entry.includes(expected));
  });
});

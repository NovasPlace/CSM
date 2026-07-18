import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  smartTitle,
  categoryForMemory,
} from '../dist/wiki-note-renderer.js';

// ============================================================================
// Smart Title
// ============================================================================

describe('smartTitle', () => {
  it('uses markdown heading', () => {
    assert.equal(smartTitle({ id: 1, content: '# My Lesson\n\nBody text' }), 'My Lesson');
  });

  it('strips [tag] prefix and uses first line', () => {
    assert.equal(smartTitle({ id: 1, content: '[user] Fix the bug in auth.ts' }), 'Fix the bug in auth.ts');
  });

  it('uses first line when no heading or prefix', () => {
    assert.equal(smartTitle({ id: 1, content: 'This is the first line\nSecond line' }), 'This is the first line');
  });

  it('truncates long titles with ellipsis', () => {
    const long = 'A'.repeat(120);
    const title = smartTitle({ id: 1, content: long });
    assert.ok(title.length <= 81); // 80 + ellipsis
    assert.ok(title.endsWith('…'));
  });

  it('falls back to Memory {id} for empty content', () => {
    assert.equal(smartTitle({ id: 42, content: '' }), 'Memory 42');
  });
});

// ============================================================================
// Category Routing
// ============================================================================

describe('categoryForMemory', () => {
  it('lessons go to lessons/', () => {
    assert.equal(
      categoryForMemory({ memoryType: 'lesson', metadata: {}, importance: 0.1 }, 0.5, false),
      'lessons',
    );
  });

  it('procedural go to lessons/', () => {
    assert.equal(
      categoryForMemory({ memoryType: 'procedural', metadata: {}, importance: 0.1 }, 0.5, false),
      'lessons',
    );
  });

  it('decisions go to decisions/', () => {
    assert.equal(
      categoryForMemory({ memoryType: 'preference', metadata: { source_kind: 'decision' }, importance: 0.1 }, 0.5, false),
      'decisions',
    );
  });

  it('promoted knowledge goes to knowledge/', () => {
    assert.equal(
      categoryForMemory({ memoryType: 'preference', metadata: { promotion_source: 'belief_promotion_engine' }, importance: 0.5 }, 0.5, false),
      'knowledge',
    );
  });

  it('workspace above threshold goes to knowledge/', () => {
    assert.equal(
      categoryForMemory({ memoryType: 'workspace', metadata: {}, importance: 0.8 }, 0.5, false),
      'knowledge',
    );
  });

  it('workspace below threshold goes to memories/', () => {
    assert.equal(
      categoryForMemory({ memoryType: 'workspace', metadata: {}, importance: 0.3 }, 0.5, false),
      'memories',
    );
  });

  it('episodic goes to memories/', () => {
    assert.equal(
      categoryForMemory({ memoryType: 'episodic', metadata: {}, importance: 0.1 }, 0.5, false),
      'memories',
    );
  });
});

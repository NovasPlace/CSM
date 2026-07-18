import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderEntityNote,
  renderMemoryNote,
  type ExportedEntity,
  type ExportedLink,
} from '../dist/wiki-note-renderer.js';

const baseMemory = {
  id: 12345,
  memoryType: 'lesson' as const,
  projectId: 'csm',
  sessionId: 'ses-abc',
  content: '# Fix embedding dimensions\n\nAlways check provider dimensions before inserting.',
  importance: 0.85,
  confidence: 0.9,
  createdAt: new Date('2026-07-15T12:00:00Z'),
  updatedAt: new Date('2026-07-15T13:00:00Z'),
  tags: ['embedding', 'bugfix'],
  metadata: {} as Record<string, unknown>,
};

describe('renderMemoryNote', () => {
  it('preserves metadata, title, tags, content, and category path', () => {
    const note = renderMemoryNote(baseMemory, [], new Set([12345]), 0.5, false);
    for (const expected of [
      'csm_id: 12345', 'type: lesson', 'importance: 0.85', '- embedding', '- bugfix',
      '# Fix embedding dimensions', 'Always check provider dimensions before inserting.',
    ]) assert.ok(note.content.includes(expected));
    assert.ok(note.path.startsWith('lessons/'));
    assert.ok(note.path.endsWith('mem-12345.md'));
  });

  it('renders exported links, plain unexported links, and backlinks honestly', () => {
    const links: ExportedLink[] = [
      { targetMemoryId: 999, linkType: 'shared_entity', strength: 0.8, direction: 'outgoing' },
      { targetMemoryId: 888, linkType: 'temporal', strength: 0.3, direction: 'outgoing' },
      { targetMemoryId: 777, linkType: 'reference', strength: 0.6, direction: 'incoming' },
    ];
    const note = renderMemoryNote(baseMemory, links, new Set([12345, 999, 777]), 0.5, false);
    assert.ok(note.content.includes('[[mem-999]]'));
    assert.ok(note.content.includes('mem-888 (not exported)'));
    assert.ok(!note.content.includes('[[mem-888]]'));
    assert.ok(note.content.includes('### Backlinks'));
    assert.ok(note.content.includes('[[mem-777]]'));
  });
});

describe('renderEntityNote', () => {
  it('renders concept metadata, referenced memories, and the entity path', () => {
    const entity: ExportedEntity = {
      conceptType: 'file', conceptValue: 'src/embeddings.ts', referencedByMemoryIds: [1, 2, 3],
    };
    const note = renderEntityNote(entity);
    assert.ok(note.content.includes('concept_type: file'));
    assert.ok(note.content.includes('referenced_by_count: 3'));
    for (const id of [1, 2, 3]) assert.ok(note.content.includes(`[[mem-${id}]]`));
    assert.ok(note.path.startsWith('entities/'));
  });
});

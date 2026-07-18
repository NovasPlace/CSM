import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderFrontmatter } from '../dist/wiki-yaml-frontmatter.js';
import { entityFilename, memoryFilename, memoryWikilink, slugify } from '../dist/wiki-slug.js';

describe('YAML Frontmatter', () => {
  it('emits safe scalars and structural values', () => {
    const scalars = renderFrontmatter({ csm_id: 12345, type: 'lesson', active: true, missing: null });
    assert.ok(scalars.startsWith('---\n'));
    assert.ok(scalars.endsWith('\n---'));
    assert.ok(scalars.includes('csm_id: 12345'));
    assert.ok(scalars.includes('type: lesson'));
    assert.ok(scalars.includes('active: true'));
    assert.ok(scalars.includes('missing: null'));
    assert.ok(renderFrontmatter({ tags: [] }).includes('tags: []'));
  });

  it('quotes ambiguous strings and escapes embedded quotes', () => {
    assert.ok(renderFrontmatter({ created_at: '2026-07-15T12:00:00Z' })
      .includes('created_at: "2026-07-15T12:00:00Z"'));
    assert.ok(renderFrontmatter({ value: 'yes' }).includes('value: "yes"'));
    assert.ok(renderFrontmatter({ value: '  spaced' }).includes('"  spaced"'));
    assert.ok(renderFrontmatter({ value: 'url: say "hi"' }).includes('"url: say \\"hi\\""'));
  });

  it('emits arrays in block style', () => {
    const result = renderFrontmatter({ tags: ['alpha', 'beta'] });
    assert.ok(result.includes('tags:'));
    assert.ok(result.includes('  - alpha'));
    assert.ok(result.includes('  - beta'));
  });
});

describe('Slug', () => {
  it('normalizes, trims, caps, and handles empty values', () => {
    assert.equal(slugify('Hello World!'), 'hello-world');
    assert.equal(slugify('src/embeddings.ts'), 'src-embeddings.ts');
    assert.equal(slugify('---test---'), 'test');
    assert.ok(slugify('a'.repeat(200), 50).length <= 50);
    assert.equal(slugify(''), 'untitled');
    assert.equal(slugify('   '), 'untitled');
  });

  it('builds stable collision-resistant entity and memory names', () => {
    const name = entityFilename('src/embeddings.ts');
    const hashPart = name.replace('.md', '').split('-').pop();
    assert.ok(name.includes('src-embeddings.ts-'));
    assert.ok(hashPart && /^[0-9a-f]{4}$/.test(hashPart));
    assert.notEqual(entityFilename('src/foo.ts'), entityFilename('src/bar.ts'));
    assert.equal(memoryFilename(12345), 'mem-12345.md');
    assert.equal(memoryWikilink(12345), 'mem-12345');
  });
});

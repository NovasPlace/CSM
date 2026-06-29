import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyTypeQuota } from '../src/memory-type-quota.js';

describe('Memory Type Quota', () => {
  it('leaves short content uncompressed', () => {
    const result = applyTypeQuota('short content', 'episodic');
    assert.equal(result.compressed, false);
    assert.equal(result.content, 'short content');
  });

  it('compresses episodic content aggressively', () => {
    const long = 'x'.repeat(2000);
    const result = applyTypeQuota(long, 'episodic');
    assert.equal(result.compressed, true);
    assert.ok(result.finalTokens < result.originalTokens);
    assert.match(result.content, /\[quota-compressed/);
  });

  it('preserves error memories even when over quota', () => {
    const errorContent = `Error: migration failed\n${'detail '.repeat(300)}\nrollback needed`;
    const result = applyTypeQuota(errorContent, 'lesson', 'frustration');
    assert.equal(result.compressed, false);
    assert.equal(result.content, errorContent);
  });

  it('preserves lesson memories with error markers', () => {
    const errorContent = `Failed to apply migration\n${'x'.repeat(2000)}`;
    const result = applyTypeQuota(errorContent, 'lesson');
    assert.equal(result.compressed, false);
  });

  it('compresses success episodic but preserves signal lines', () => {
    const content = `line one\nerror: something\n${'filler '.repeat(200)}\ngoal: fix the bug`;
    const result = applyTypeQuota(content, 'episodic');
    assert.equal(result.compressed, true);
    assert.match(result.content, /\[EPI\]/);
  });

  it('respects higher quota for lessons vs episodic', () => {
    const content = 'x'.repeat(1200);
    const lessonResult = applyTypeQuota(content, 'lesson');
    const episodicResult = applyTypeQuota(content, 'episodic');
    assert.ok(lessonResult.finalTokens >= episodicResult.finalTokens);
  });

  it('handles empty content gracefully', () => {
    const result = applyTypeQuota('', 'conversation');
    assert.equal(result.compressed, false);
    assert.equal(result.content, '');
  });
});

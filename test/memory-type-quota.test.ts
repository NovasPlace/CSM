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

  it('preserves a NEUTRAL lesson that is over quota and has no error markers', () => {
    // Regression: `lesson` was only preserved when emotion === 'frustration' or the text
    // happened to contain an error word. memory_lesson stamps 'frustration', so it always
    // survived; save_memory({type:'lesson'}) defaults to 'neutral' and was silently summarised.
    const long = `${'alpha beta gamma delta '.repeat(400)}`;
    const result = applyTypeQuota(long, 'lesson');
    assert.ok(result.originalTokens > 800, `fixture must exceed the 800-token lesson quota, got ${result.originalTokens}`);
    assert.equal(result.compressed, false);
    assert.equal(result.content, long);
    assert.doesNotMatch(result.content, /\[LESSON\]|\[quota-compressed/);
  });

  it('preserves a neutral lesson identically to a frustration lesson', () => {
    const long = `${'alpha beta gamma delta '.repeat(400)}`;
    const neutral = applyTypeQuota(long, 'lesson', 'neutral');
    const frustrated = applyTypeQuota(long, 'lesson', 'frustration');
    assert.equal(neutral.content, frustrated.content);
    assert.equal(neutral.compressed, frustrated.compressed);
  });

  it('still compresses other types over quota (preserveAlways is scoped to lesson)', () => {
    const long = `${'alpha beta gamma delta '.repeat(400)}`;
    for (const type of ['workspace', 'preference', 'episodic'] as const) {
      const result = applyTypeQuota(long, type);
      assert.equal(result.compressed, true, `${type} should still compress`);
      assert.match(result.content, /\[quota-compressed/);
    }
  });
});

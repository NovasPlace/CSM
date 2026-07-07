import { strict as assert } from 'assert';
import { test } from 'node:test';
import { ToolExecuteRuntimeDedup } from '../src/tool-execute-runtime-dedup.js';

test('ToolExecuteRuntimeDedup: same tool+args within TTL suppresses', () => {
  const dedup = new ToolExecuteRuntimeDedup(60_000);
  const first = dedup.shouldSuppress('edit', { filePath: '/a.ts' });
  assert.equal(first, false, 'first call should not suppress');
  const second = dedup.shouldSuppress('edit', { filePath: '/a.ts' });
  assert.equal(second, true, 'second call within TTL should suppress');
});

test('ToolExecuteRuntimeDedup: different args do not suppress', () => {
  const dedup = new ToolExecuteRuntimeDedup(60_000);
  const first = dedup.shouldSuppress('edit', { filePath: '/a.ts' });
  assert.equal(first, false);
  const second = dedup.shouldSuppress('edit', { filePath: '/b.ts' });
  assert.equal(second, false, 'different args should not suppress');
});

test('ToolExecuteRuntimeDedup: same tool+args after TTL expires allows', () => {
  const dedup = new ToolExecuteRuntimeDedup(10);
  const first = dedup.shouldSuppress('bash', { command: 'ls' });
  assert.equal(first, false);
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      const after = dedup.shouldSuppress('bash', { command: 'ls' });
      assert.equal(after, false, 'after TTL expires should not suppress');
      resolve();
    }, 30);
  });
});

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { measureCompactionQuality } from '../src/compaction-quality.js';
import type { EmbeddingGenerator } from '../src/embeddings.js';
import { captureErrorLogs } from './logger-capture.js';

it('logs embedding degradation while preserving the established fallback score', async () => {
  const failure = new Error('embedding provider unavailable');
  const generator = {
    generate: async () => { throw failure; },
  } as unknown as EmbeddingGenerator;

  const captured = await captureErrorLogs(() => measureCompactionQuality(
    'Decision: preserve src/critical.ts because rollback is required.',
    'Decision: preserve src/critical.ts because rollback is required.',
    100,
    80,
    generator,
  ));
  const result = captured.result;

  assert.equal(result.embeddingDrift, -1);
  assert.equal(result.tokensSavedTotal, 20);
  assert.equal(captured.errors.length, 1);
  assert.equal(captured.errors[0][0],
    'Compaction embedding quality comparison unavailable');
  assert.equal(captured.errors[0][1], failure);
});

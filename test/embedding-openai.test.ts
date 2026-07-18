import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EmbeddingGenerator, EMBEDDING_DIMENSIONS } from '../dist/embeddings.js';

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock.fn>;

function mockOpenAIResponse(embedding: number[] = new Array(EMBEDDING_DIMENSIONS).fill(0.4)) {
  return Promise.resolve(new Response(JSON.stringify({ data: [{ embedding }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
}

describe('EmbeddingGenerator OpenAI API', () => {
  beforeEach(() => {
    mockFetch = mock.fn(() => mockOpenAIResponse());
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  it('calls POST /embeddings with input field and Bearer auth', async () => {
    const gen = new EmbeddingGenerator({
      embeddingModel: 'text-embedding-3-small',
      embeddingApiKey: 'sk-test-key-123',
      embeddingApiUrl: 'https://api.openai.com/v1',
    });
    await gen.generate('hello world');
    assert.equal(mockFetch.mock.callCount(), 1);
    const [url, opts] = mockFetch.mock.calls[0].arguments as [string, RequestInit];
    assert.equal(url, 'https://api.openai.com/v1/embeddings');
    assert.equal(opts.method, 'POST');
    assert.equal((opts.headers as Record<string, string>).Authorization, 'Bearer sk-test-key-123');
    const body = JSON.parse(opts.body as string);
    assert.deepEqual(
      { model: body.model, input: body.input, dimensions: body.dimensions },
      { model: 'text-embedding-3-small', input: 'hello world', dimensions: EMBEDDING_DIMENSIONS },
    );
  });

  it('returns embedding from response.data[0].embedding', async () => {
    mockFetch = mock.fn(() => mockOpenAIResponse(new Array(EMBEDDING_DIMENSIONS).fill(0.5)));
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    const gen = new EmbeddingGenerator({ embeddingModel: 'text-embedding-3-small', embeddingApiKey: 'sk-test' });
    const result = await gen.generate('test');
    assert.equal(result.length, EMBEDDING_DIMENSIONS);
    assert.equal(result[0], 0.5);
  });
});

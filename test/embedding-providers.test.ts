import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EmbeddingGenerator } from '../dist/embeddings.js';
import { chunkEmbeddingText } from '../dist/embedding-vector.js';

const OLLAMA_DIMENSIONS = 768;

// Mock fetch globally for API tests
const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock.fn>;

function mockOllamaResponse(embedding: number[] = new Array(OLLAMA_DIMENSIONS).fill(0.1)) {
  return Promise.resolve(new Response(JSON.stringify({ embedding }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
}

function mockErrorResponse(status = 500, statusText = 'Internal Server Error') {
  return Promise.resolve(new Response(null, { status, statusText }));
}

describe('EmbeddingGenerator provider resolution', () => {
  it('resolves to ollama when embeddingApiUrl is set without embeddingApiKey', () => {
    const gen = new EmbeddingGenerator({
      embeddingModel: 'nomic-embed-text',
      embeddingApiUrl: 'http://localhost:11434',
    });
    const info = gen.getProviderInfo();
    assert.equal(info.provider, 'ollama');
    assert.equal(info.model, 'nomic-embed-text');
  });

  it('resolves to openai when embeddingApiKey is set', () => {
    const gen = new EmbeddingGenerator({
      embeddingModel: 'text-embedding-3-small',
      embeddingApiKey: 'sk-test-key',
      embeddingApiUrl: 'https://api.openai.com/v1',
    });
    const info = gen.getProviderInfo();
    assert.equal(info.provider, 'openai');
    assert.equal(info.model, 'text-embedding-3-small');
  });

  it('resolves to hash when neither apiKey nor apiUrl is set', () => {
    const gen = new EmbeddingGenerator({
      embeddingModel: 'nomic-embed-text',
    });
    const info = gen.getProviderInfo();
    assert.equal(info.provider, 'hash');
    assert.equal(info.model, 'nomic-embed-text');
  });

  it('openai takes precedence when both apiKey and apiUrl are set', () => {
    const gen = new EmbeddingGenerator({
      embeddingModel: 'text-embedding-3-small',
      embeddingApiKey: 'sk-test',
      embeddingApiUrl: 'http://localhost:11434',
    });
    const info = gen.getProviderInfo();
    assert.equal(info.provider, 'openai');
  });
});

describe('EmbeddingGenerator Ollama API', () => {
  beforeEach(() => {
    mockFetch = mock.fn(() => mockOllamaResponse());
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('calls POST /api/embeddings with prompt field (no auth header)', async () => {
    const gen = new EmbeddingGenerator({
      embeddingModel: 'nomic-embed-text',
      embeddingApiUrl: 'http://localhost:11434',
    });

    await gen.generate('hello world');

    assert.equal(mockFetch.mock.callCount(), 1);
    const [url, opts] = mockFetch.mock.calls[0].arguments as [string, RequestInit];

    assert.equal(url, 'http://localhost:11434/api/embeddings');
    assert.equal(opts.method, 'POST');

    const headers = opts.headers as Record<string, string>;
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(headers['Authorization'], undefined, 'Ollama should not have auth header');

    const body = JSON.parse(opts.body as string);
    assert.equal(body.model, 'nomic-embed-text');
    assert.equal(body.prompt, 'hello world');
    assert.equal(body.input, undefined, 'Ollama uses prompt, not input');
  });

  it('returns embedding from response.embedding (not data[0].embedding)', async () => {
    const embedding = new Array(OLLAMA_DIMENSIONS).fill(0.1);
    mockFetch = mock.fn(() => mockOllamaResponse(embedding));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const gen = new EmbeddingGenerator({
      embeddingModel: 'nomic-embed-text',
      embeddingApiUrl: 'http://localhost:11434',
    });

    const result = await gen.generate('test');
    assert.equal(result.length, OLLAMA_DIMENSIONS);
    assert.equal(result[0], 0.1);
  });

  it('falls back to hash embedding on API errors instead of crashing', async () => {
    mockFetch = mock.fn(() => mockErrorResponse(503, 'Service Unavailable'));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const gen = new EmbeddingGenerator({
      embeddingModel: 'nomic-embed-text',
      embeddingApiUrl: 'http://localhost:11434',
    });

    const result = await gen.generate('test text');
    assert.equal(result.length, OLLAMA_DIMENSIONS);
  });

  it('falls back to hash embedding when provider returns wrong dimension', async () => {
    mockFetch = mock.fn(() => mockOllamaResponse([0.1, 0.2, 0.3]));
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    const gen = new EmbeddingGenerator({
      embeddingModel: 'nomic-embed-text',
      embeddingApiUrl: 'http://localhost:11434',
    });
    const result = await gen.generate('test');
    assert.equal(result.length, OLLAMA_DIMENSIONS);
  });

  it('uses configured Ollama URL from constructor', async () => {
    mockFetch = mock.fn(() => mockOllamaResponse());
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const gen = new EmbeddingGenerator({
      embeddingModel: 'nomic-embed-text',
      embeddingApiUrl: 'http://custom-host:9999',
    });

    await gen.generate('test');
    const url = mockFetch.mock.calls[0].arguments[0] as string;
    assert.equal(url, 'http://custom-host:9999/api/embeddings');
  });
});

describe('EmbeddingGenerator hash provider', () => {
  it('generates deterministic hash embeddings', async () => {
    const gen = new EmbeddingGenerator({ embeddingModel: 'test' });

    const a = await gen.generate('hello');
    const b = await gen.generate('hello');
    assert.deepEqual(a, b, 'same input should produce same hash embedding');
  });

  it('produces unit vectors', async () => {
    const gen = new EmbeddingGenerator({ embeddingModel: 'test' });
    const embedding = await gen.generate('test input');
    const magnitude = Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0));
    assert.ok(magnitude > 0.99 && magnitude < 1.01, 'hash embedding should be unit vector');
  });

  it('different inputs produce different embeddings', async () => {
    const gen = new EmbeddingGenerator({ embeddingModel: 'test' });
    const a = await gen.generate('hello');
    const b = await gen.generate('world');
    const dot = a.reduce((sum, value, index) => sum + value * b[index], 0);
    assert.ok(dot < 0.99, 'different inputs should produce different embeddings');
  });
});

describe('EmbeddingGenerator chunking', () => {
  it('returns single chunk for short text', async () => {
    const chunks = chunkEmbeddingText('short text');
    assert.equal(chunks.length, 1);
  });

  it('splits long text into multiple chunks', async () => {
    const longText = 'This is a sentence. '.repeat(200); // ~2000 chars = ~500 tokens
    const chunks = chunkEmbeddingText(longText);
    assert.ok(chunks.length > 1, 'long text should produce multiple chunks');
  });
});

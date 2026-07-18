export interface RemoteEmbeddingConfig {
  apiKey?: string;
  apiUrl?: string;
  dimensions: number;
  model: string;
  provider: 'ollama' | 'openai';
}

export async function requestRemoteEmbedding(
  config: RemoteEmbeddingConfig,
  text: string,
): Promise<number[]> {
  const response = config.provider === 'ollama'
    ? await requestOllama(config, text)
    : await requestOpenAi(config, text);
  return validateEmbedding(response, config.dimensions, config.provider);
}

async function requestOllama(
  config: RemoteEmbeddingConfig,
  text: string,
): Promise<unknown> {
  const baseUrl = config.apiUrl ?? 'http://localhost:11434';
  const response = await fetch(`${baseUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, prompt: text }),
  });
  await requireOk(response, 'Ollama');
  const data = await response.json() as { embedding?: unknown };
  return data.embedding;
}

async function requestOpenAi(
  config: RemoteEmbeddingConfig,
  text: string,
): Promise<unknown> {
  const baseUrl = config.apiUrl ?? 'https://api.openai.com/v1';
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey ?? ''}`,
    },
    body: JSON.stringify({ model: config.model, input: text, dimensions: config.dimensions }),
  });
  await requireOk(response, 'OpenAI');
  const data = await response.json() as { data?: Array<{ embedding?: unknown }> };
  return data.data?.[0]?.embedding;
}

async function requireOk(response: Response, provider: string): Promise<void> {
  if (!response.ok) {
    throw new Error(`${provider} embedding API error: ${response.status} ${response.statusText}`);
  }
}

function validateEmbedding(value: unknown, dimensions: number, provider: string): number[] {
  if (!Array.isArray(value) || !value.every(Number.isFinite)) {
    throw new Error(`${provider} embedding response did not contain a finite numeric vector`);
  }
  if (value.length !== dimensions) {
    throw new Error(`${provider} embedding dimension mismatch: expected ${dimensions}, received ${value.length}`);
  }
  return value as number[];
}

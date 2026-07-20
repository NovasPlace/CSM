import type { PluginConfig } from './types.js';
import { requestRemoteEmbedding } from './embedding-provider-client.js';
import {
  averageEmbeddings,
  chunkEmbeddingText,
  hashEmbedding,
  type EmbeddingChunk,
} from './embedding-vector.js';

export const EMBEDDING_DIMENSIONS = readDefaultDimensions();
export type { EmbeddingChunk };

export type EmbeddingProvider = 'ollama' | 'openai' | 'hash';

export interface EmbeddingProviderInfo {
  provider: EmbeddingProvider;
  model: string;
}

export type EmbeddingConfig = Pick<PluginConfig, 'embeddingModel'> &
  Partial<Pick<PluginConfig, 'embeddingApiKey' | 'embeddingApiUrl'>> & {
    embeddingDimensions?: number;
  };

export class EmbeddingGenerator {
  private readonly config: EmbeddingConfig;
  private readonly provider: EmbeddingProvider;
  private readonly dimensions: number;

  constructor(config: EmbeddingConfig) {
    this.config = config;
    this.provider = resolveProvider(config);
    this.dimensions = resolveDimensions(config, this.provider);
  }

  getProviderInfo(): EmbeddingProviderInfo {
    return { provider: this.provider, model: this.config.embeddingModel };
  }

  getExpectedDimensions(): number {
    return this.dimensions;
  }

  async probeDimensions(): Promise<number> {
    return (await this.generate('probe')).length;
  }

  async generate(text: string): Promise<number[]> {
    const chunks = chunkEmbeddingText(text);
    const embeddings: number[][] = [];
    for (const chunk of chunks) embeddings.push(await this.generateChunk(chunk));
    return averageEmbeddings(embeddings, this.dimensions);
  }

  async generateBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) results.push(await this.generate(text));
    return results;
  }

  private generateChunk(chunk: EmbeddingChunk): Promise<number[]> {
    if (this.provider === 'hash') {
      return Promise.resolve(hashEmbedding(chunk.content, this.dimensions));
    }
    return requestRemoteEmbedding({
      provider: this.provider,
      model: this.config.embeddingModel,
      dimensions: this.dimensions,
      apiKey: this.config.embeddingApiKey,
      apiUrl: this.config.embeddingApiUrl,
    }, chunk.content);
  }
}

function resolveProvider(config: EmbeddingConfig): EmbeddingProvider {
  if (config.embeddingApiKey) return 'openai';
  if (config.embeddingApiUrl) return 'ollama';
  return 'hash';
}

function resolveDimensions(config: EmbeddingConfig, provider: EmbeddingProvider): number {
  const configured = config.embeddingDimensions;
  if (configured !== undefined) {
    if (!Number.isInteger(configured) || configured <= 0) {
      throw new Error('embeddingDimensions must be a positive integer');
    }
    return configured;
  }
  if (provider === 'ollama') return 768;
  return EMBEDDING_DIMENSIONS;
}

function readDefaultDimensions(): number {
  const parsed = Number(process.env.CSM_EMBEDDING_DIMENSIONS
    ?? process.env.EMBEDDING_DIMENSIONS
    ?? 1_536);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1_536;
}

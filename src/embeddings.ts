// Embedding generation for semantic search
// Supports OpenAI API or local embedding models

import { PluginConfig } from './types.js';
import { getLogger } from './logger.js';

export const EMBEDDING_DIMENSIONS = 1536;

export interface EmbeddingChunk {
  content: string;
  tokenCount: number;
}

// Narrower config type so EmbeddingGenerator can be constructed with either
// a full PluginConfig or a partial object with only embedding fields.
export type EmbeddingConfig = Pick<PluginConfig, 'embeddingModel'> &
  Partial<Pick<PluginConfig, 'embeddingApiKey' | 'embeddingApiUrl'>>;

export class EmbeddingGenerator {
  private config: EmbeddingConfig;

  constructor(config: EmbeddingConfig) {
    this.config = config;
  }

  /**
   * Generate embedding for a single text
   */
  async generate(text: string): Promise<number[]> {
    const chunks = this.chunkText(text);
    const embeddings: number[][] = [];

    for (const chunk of chunks) {
      const embedding = await this.generateForChunk(chunk);
      embeddings.push(embedding);
    }

    // Return average of all chunk embeddings
    return this.averageEmbeddings(embeddings);
  }

  /**
   * Generate embeddings for multiple texts
   */
  async generateBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];

    for (const text of texts) {
      const embedding = await this.generate(text);
      results.push(embedding);
    }

    return results;
  }

  /**
   * Generate embedding for a single chunk
   */
  private async generateForChunk(chunk: EmbeddingChunk): Promise<number[]> {
    if (this.config.embeddingApiKey) {
      return this.generateOpenAI(chunk.content);
    }

    // Fallback to simple hash-based embedding (for testing)
    return this.generateHashEmbedding(chunk.content);
  }

  /**
   * Generate embedding using OpenAI API
   */
  private async generateOpenAI(text: string): Promise<number[]> {
    const baseUrl = this.config.embeddingApiUrl || 'https://api.openai.com/v1';
    
    try {
      const response = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.embeddingApiKey}`,
        },
        body: JSON.stringify({
          model: this.config.embeddingModel,
          input: text,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.statusText}`);
      }

      const data = await response.json() as { data: { embedding: number[] }[] };
       return data.data[0].embedding;
     } catch (error) {
       getLogger().error('OpenAI API failed', error instanceof Error ? error : undefined);
       // Fallback to hash embedding
      return this.generateHashEmbedding(text);
    }
  }

  /**
   * Generate a simple hash-based embedding (for testing/fallback)
   * This is NOT a real embedding - just for development purposes
   */
  private generateHashEmbedding(text: string): number[] {
    const embedding: number[] = new Array(EMBEDDING_DIMENSIONS).fill(0);

    // Simple hash-based embedding
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i);
      const index = (charCode * (i + 1)) % EMBEDDING_DIMENSIONS;
      embedding[index] += 1;
    }

    // Normalize
    const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    if (magnitude > 0) {
      for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
        embedding[i] /= magnitude;
      }
    }

    return embedding;
  }

  /**
   * Chunk text into smaller pieces for embedding
   * Target: 300-500 tokens with 40-80 token overlap
   */
  private chunkText(text: string, targetTokens: number = 400, overlap: number = 60): EmbeddingChunk[] {
    // Rough token estimation (1 token ≈ 4 characters)
    const estimatedTokens = Math.ceil(text.length / 4);
    
    if (estimatedTokens <= targetTokens) {
      return [{ content: text, tokenCount: estimatedTokens }];
    }

    const chunks: EmbeddingChunk[] = [];
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    
    let currentChunk = '';
    let currentTokens = 0;

    for (const sentence of sentences) {
      const sentenceTokens = Math.ceil(sentence.length / 4);
      
      if (currentTokens + sentenceTokens > targetTokens && currentChunk.length > 0) {
        chunks.push({
          content: currentChunk.trim(),
          tokenCount: currentTokens,
        });
        
        // Keep overlap
        const words = currentChunk.split(' ');
        const overlapWords = words.slice(-Math.floor(overlap / 4));
        currentChunk = overlapWords.join(' ') + ' ' + sentence;
        currentTokens = Math.ceil(currentChunk.length / 4);
      } else {
        currentChunk += (currentChunk ? '. ' : '') + sentence;
        currentTokens += sentenceTokens;
      }
    }

    if (currentChunk.trim().length > 0) {
      chunks.push({
        content: currentChunk.trim(),
        tokenCount: currentTokens,
      });
    }

    return chunks;
  }

  /**
   * Average multiple embeddings into one
   */
  private averageEmbeddings(embeddings: number[][]): number[] {
    if (embeddings.length === 0) {
      return new Array(EMBEDDING_DIMENSIONS).fill(0);
    }

    if (embeddings.length === 1) {
      return embeddings[0];
    }

    const dimensions = embeddings[0].length;
    const averaged: number[] = new Array(dimensions).fill(0);

    for (const embedding of embeddings) {
      for (let i = 0; i < dimensions; i++) {
        averaged[i] += embedding[i];
      }
    }

    for (let i = 0; i < dimensions; i++) {
      averaged[i] /= embeddings.length;
    }

    return averaged;
  }
}

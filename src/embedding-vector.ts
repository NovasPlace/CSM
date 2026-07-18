export interface EmbeddingChunk {
  content: string;
  tokenCount: number;
}

export function chunkEmbeddingText(
  text: string,
  targetTokens = 400,
  overlapTokens = 60,
): EmbeddingChunk[] {
  if (Math.ceil(text.length / 4) <= targetTokens) {
    return [{ content: text, tokenCount: Math.ceil(text.length / 4) }];
  }
  return buildChunks(text, targetTokens, overlapTokens);
}

function buildChunks(text: string, targetTokens: number, overlapTokens: number): EmbeddingChunk[] {
  const sentences = text.split(/[.!?]+/).filter((sentence) => sentence.trim().length > 0);
  const chunks: EmbeddingChunk[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (Math.ceil((current.length + sentence.length) / 4) > targetTokens && current) {
      chunks.push(toChunk(current));
      current = overlap(current, overlapTokens) + sentence;
    } else {
      current += `${current ? '. ' : ''}${sentence}`;
    }
  }
  if (current.trim()) chunks.push(toChunk(current));
  return chunks;
}

function overlap(text: string, overlapTokens: number): string {
  const words = text.split(' ');
  const suffix = words.slice(-Math.floor(overlapTokens / 4)).join(' ');
  return suffix ? `${suffix} ` : '';
}

function toChunk(content: string): EmbeddingChunk {
  const normalized = content.trim();
  return { content: normalized, tokenCount: Math.ceil(normalized.length / 4) };
}

export function averageEmbeddings(embeddings: number[][], dimensions: number): number[] {
  if (embeddings.length === 0) return new Array(dimensions).fill(0);
  if (embeddings.length === 1) return embeddings[0];
  const averaged = new Array(dimensions).fill(0) as number[];
  for (const embedding of embeddings) {
    if (embedding.length !== dimensions) throw new Error('Cannot average embeddings with mixed dimensions');
    for (let index = 0; index < dimensions; index++) averaged[index] += embedding[index];
  }
  return averaged.map((value) => value / embeddings.length);
}

export function hashEmbedding(text: string, dimensions: number): number[] {
  const embedding = new Array(dimensions).fill(0) as number[];
  for (let index = 0; index < text.length; index++) {
    const bucket = (text.charCodeAt(index) * (index + 1)) % dimensions;
    embedding[bucket] += 1;
  }
  const magnitude = Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0));
  return magnitude === 0 ? embedding : embedding.map((value) => value / magnitude);
}

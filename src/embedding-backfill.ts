import type { Database } from './database.js';
import { EmbeddingGenerator } from './embeddings.js';
import { getLogger } from './logger.js';
import { nowFn } from './db/query-dialect.js';

export interface EmbeddingBackfillConfig {
  batchSize?: number;
  maxTotal?: number;
  projectId?: string;
  dryRun?: boolean;
  batchDelayMs?: number;
}

export interface EmbeddingBackfillResult {
  totalMissing: number;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  isComplete: boolean;
}

export class EmbeddingBackfill {
  private readonly database: Database;
  private readonly pool: ReturnType<Database['getPool']>;
  private readonly embeddings: EmbeddingGenerator;

  constructor(database: Database, embeddings: EmbeddingGenerator) {
    this.database = database;
    this.pool = database.getPool();
    this.embeddings = embeddings;
  }

  async countMissing(projectId?: string): Promise<number> {
    const params: unknown[] = [];
    const project = projectId ? ` AND project_id = $${push(params, projectId)}` : '';
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS cnt FROM memories WHERE embedding IS NULL${project}`,
      params,
    );
    return Number((result.rows[0] as { cnt?: unknown }).cnt ?? 0);
  }

  async backfill(config: EmbeddingBackfillConfig = {}): Promise<EmbeddingBackfillResult> {
    const settings = validateConfig(config);
    const totalMissing = await this.countMissing(settings.projectId);
    getLogger().info(`Embedding backfill: ${totalMissing} memories missing embeddings`);
    if (settings.dryRun) return resultOf(totalMissing, 0, 0);
    const target = settings.maxTotal > 0 ? Math.min(settings.maxTotal, totalMissing) : totalMissing;
    const progress = { succeeded: 0, failed: 0, lastId: 0 };
    while (progress.succeeded + progress.failed < target) {
      const remaining = target - progress.succeeded - progress.failed;
      const rows = await this.readBatch(settings, progress.lastId, Math.min(settings.batchSize, remaining));
      if (rows.length === 0) break;
      await this.processBatch(rows, progress);
      progress.lastId = rows.at(-1)?.id ?? progress.lastId;
      if (settings.batchDelayMs > 0) await delay(settings.batchDelayMs);
    }
    const result = resultOf(totalMissing, progress.succeeded, progress.failed);
    getLogger().info(`Embedding backfill: ${result.succeeded} succeeded, ${result.failed} failed, ${result.skipped} skipped`);
    return result;
  }

  private async readBatch(
    config: Required<EmbeddingBackfillConfig>,
    lastId: number,
    limit: number,
  ): Promise<Array<{ id: number; content: string }>> {
    const params: unknown[] = [lastId];
    const project = config.projectId ? ` AND project_id = $${push(params, config.projectId)}` : '';
    params.push(limit);
    const result = await this.pool.query(
      `SELECT id, content FROM memories WHERE embedding IS NULL AND id > $1${project}
       ORDER BY id ASC LIMIT $${params.length}`,
      params,
    );
    return result.rows as Array<{ id: number; content: string }>;
  }

  private async processBatch(
    rows: Array<{ id: number; content: string }>,
    progress: { succeeded: number; failed: number },
  ): Promise<void> {
    for (const row of rows) {
      try {
        const embedding = await this.embeddings.generate(row.content);
        await this.storeEmbedding(row.id, row.content, embedding);
        progress.succeeded++;
      } catch (error) {
        getLogger().error(`Backfill failed for memory ${row.id}`, error as Error);
        progress.failed++;
      }
    }
  }

  private async storeEmbedding(memoryId: number, content: string, embedding: number[]): Promise<void> {
    const vector = `[${embedding.join(',')}]`;
    await this.pool.query(
      `INSERT INTO memory_chunks
       (memory_id, chunk_index, content, token_count, embedding, embedding_model)
       VALUES ($1, 0, $2, $3, $4, $5)
       ON CONFLICT (memory_id, chunk_index) DO UPDATE SET
         content = EXCLUDED.content, token_count = EXCLUDED.token_count,
         embedding = EXCLUDED.embedding, embedding_model = EXCLUDED.embedding_model`,
      [memoryId, content, Math.ceil(content.length / 4), vector, this.embeddingModel()],
    );
    await this.pool.query(
      `UPDATE memories SET embedding = $1, updated_at = ${nowFn(this.database.dialect)} WHERE id = $2`,
      [vector, memoryId],
    );
  }

  private embeddingModel(): string {
    const info = this.embeddings.getProviderInfo();
    return `${info.provider}:${info.model}`;
  }
}

function validateConfig(config: EmbeddingBackfillConfig): Required<EmbeddingBackfillConfig> {
  const result = {
    batchSize: config.batchSize ?? 50,
    maxTotal: config.maxTotal ?? 0,
    projectId: config.projectId ?? '',
    dryRun: config.dryRun ?? false,
    batchDelayMs: config.batchDelayMs ?? 100,
  };
  if (!Number.isInteger(result.batchSize) || result.batchSize <= 0) throw new Error('batchSize must be positive');
  if (!Number.isInteger(result.maxTotal) || result.maxTotal < 0) throw new Error('maxTotal cannot be negative');
  if (!Number.isInteger(result.batchDelayMs) || result.batchDelayMs < 0) throw new Error('batchDelayMs cannot be negative');
  return result;
}

function resultOf(total: number, succeeded: number, failed: number): EmbeddingBackfillResult {
  const attempted = succeeded + failed;
  return {
    totalMissing: total, attempted, succeeded, failed,
    skipped: Math.max(0, total - attempted),
    isComplete: failed === 0 && attempted >= total,
  };
}

function push(params: unknown[], value: unknown): number { params.push(value); return params.length; }
function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

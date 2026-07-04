import type { Database } from './database.js';
import { EmbeddingGenerator } from './embeddings.js';
import { getLogger } from './logger.js';
import { nowFn } from './db/query-dialect.js';

export interface EmbeddingBackfillConfig {
  /** Memories per batch (default 50) */
  batchSize?: number;
  /** Max total to process across all batches (0 = unlimited, default 0) */
  maxTotal?: number;
  /** Optional project scope filter */
  projectId?: string;
  /** Dry-run: count only, no writes (default false) */
  dryRun?: boolean;
  /** Rate-limit delay in ms between batches (default 100) */
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
  private database: Database;
  private pool: ReturnType<Database['getPool']>;
  private embeddings: EmbeddingGenerator;

  constructor(
    database: Database,
    embeddings: EmbeddingGenerator,
  ) {
    this.database = database;
    this.pool = database.getPool();
    this.embeddings = embeddings;
  }

  async countMissing(projectId?: string): Promise<number> {
    const params: unknown[] = [];
    let sql = 'SELECT COUNT(*)::int AS cnt FROM memories WHERE embedding IS NULL';
    if (projectId) {
      params.push(projectId);
      sql += ' AND project_id = $1';
    }
    const result = await this.pool.query(sql, params);
    return (result.rows[0] as { cnt: number }).cnt;
  }

  async backfill(config?: EmbeddingBackfillConfig): Promise<EmbeddingBackfillResult> {
    const logger = getLogger();
    const batchSize = config?.batchSize ?? 50;
    const maxTotal = config?.maxTotal ?? 0;
    const batchDelayMs = config?.batchDelayMs ?? 100;
    const projectId = config?.projectId;
    const dryRun = config?.dryRun ?? false;

    const totalMissing = await this.countMissing(projectId);
    logger.info(`Embedding backfill: ${totalMissing} memories missing embeddings`);

    if (dryRun) {
      logger.info('Embedding backfill: dry-run, no writes');
      return { totalMissing, attempted: 0, succeeded: 0, failed: 0, skipped: totalMissing, isComplete: true };
    }

    let succeeded = 0;
    let failed = 0;
    let offset = 0;
    let batchIndex = 0;
    const target = maxTotal > 0 ? Math.min(maxTotal, totalMissing) : totalMissing;

    while (succeeded + failed < target) {
      const params: unknown[] = [batchSize, offset];
      let sql = `SELECT id, content FROM memories WHERE embedding IS NULL ORDER BY id ASC LIMIT $1 OFFSET $2`;
      if (projectId) {
        params.push(projectId);
        sql += ' AND project_id = $3';
      }

      const result = await this.pool.query(sql, params);
      const rows = result.rows as Array<{ id: number; content: string }>;
      if (rows.length === 0) break;

      batchIndex++;
      logger.info(`Batch ${batchIndex}: ${rows.length} rows at offset ${offset}`);

      for (const row of rows) {
        if (succeeded + failed >= target) break;
        try {
          const embedding = await this.embeddings.generate(row.content);
          await this.storeEmbedding(row.id, row.content, embedding);
          succeeded++;
        } catch (error) {
          logger.error(`Backfill failed for memory ${row.id}`, error as Error);
          failed++;
        }
      }

      offset += batchSize;

      if (batchDelayMs > 0) {
        await new Promise((r) => setTimeout(r, batchDelayMs));
      }
    }

    const attempted = succeeded + failed;
    const skipped = target - attempted;
    logger.info(
      `Backfill done: ${totalMissing} missing, ${succeeded} ok, ${failed} fail, ${skipped} skip`,
    );

    return {
      totalMissing,
      attempted,
      succeeded,
      failed,
      skipped,
      isComplete: attempted + failed >= totalMissing,
    };
  }

   private async storeEmbedding(memoryId: number, content: string, embedding: number[]): Promise<void> {
    const vector = `[${embedding.join(',')}]`;
    await this.pool.query(
      `UPDATE memories SET embedding = $1, updated_at = ${nowFn(this.database.dialect)} WHERE id = $2`,
      [vector, memoryId],
    );
    await this.pool.query(
      `INSERT INTO memory_chunks
       (memory_id, chunk_index, content, token_count, embedding, embedding_model)
       VALUES ($1, 0, $2, $3, $4, $5)
       ON CONFLICT (memory_id, chunk_index) DO UPDATE SET
         content = EXCLUDED.content,
         token_count = EXCLUDED.token_count,
         embedding = EXCLUDED.embedding,
         embedding_model = EXCLUDED.embedding_model`,
      [memoryId, content, Math.ceil(content.length / 4), vector, 'embedding-backfill'],
    );
  }
}

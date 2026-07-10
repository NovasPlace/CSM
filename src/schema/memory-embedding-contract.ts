import type { DatabasePool } from '../types.js';
import { EMBEDDING_DIMENSIONS } from '../embeddings.js';
import { getLogger } from '../logger.js';

export async function ensureEmbeddingColumnContract(pool: DatabasePool): Promise<void> {
  const result = await pool.query(
    `SELECT format_type(a.atttypid, a.atttypmod) AS column_type
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'memories'
       AND a.attname = 'embedding'
       AND a.attnum > 0
       AND NOT a.attisdropped`,
  );
  if (result.rows.length === 0) {
    await addEmbeddingColumn(pool);
    return;
  }
  const row = result.rows[0] as { column_type?: string };
  const expectedType = `vector(${EMBEDDING_DIMENSIONS})`;
  if (row.column_type === expectedType) return;
  await replaceEmbeddingColumn(pool, row.column_type, expectedType);
}

async function addEmbeddingColumn(pool: DatabasePool): Promise<void> {
  await pool.query(`ALTER TABLE memories ADD COLUMN embedding VECTOR(${EMBEDDING_DIMENSIONS})`);
}

async function replaceEmbeddingColumn(
  pool: DatabasePool,
  previousType: string | undefined,
  expectedType: string,
): Promise<void> {
  const legacyColumn = `embedding_legacy_${Date.now()}`;
  await pool.query(`ALTER TABLE memories RENAME COLUMN embedding TO ${legacyColumn}`);
  await addEmbeddingColumn(pool);
  getLogger().warn(
    `Embedding dimension changed: ${previousType ?? '(unknown)'} → ${expectedType}. Old column preserved as ${legacyColumn}. Run csm_memory_backfill_embeddings tool to regenerate embeddings at the new dimension.`,
  );
}

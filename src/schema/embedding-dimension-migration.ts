import type { DatabasePool } from '../types.js';
import { getLogger } from '../logger.js';

interface EmbeddingColumnTarget {
  column: string;
  table: string;
}

const TARGETS: EmbeddingColumnTarget[] = [
  { table: 'memories', column: 'embedding' },
  { table: 'memory_chunks', column: 'embedding' },
];

export async function migrateEmbeddingDimensions(
  pool: DatabasePool,
  dimensions: number,
): Promise<void> {
  requireDimensions(dimensions);
  for (const target of TARGETS) await migrateColumn(pool, target, dimensions);
}

async function migrateColumn(
  pool: DatabasePool,
  target: EmbeddingColumnTarget,
  dimensions: number,
): Promise<void> {
  const current = await columnDimensions(pool, target);
  if (current === dimensions) {
    await repairMisreadLegacy(pool, target, dimensions);
    return;
  }
  if (current === null) {
    if (target.table === 'memory_chunks') await dropChunkVectorIndex(pool);
    await addReplacementColumn(pool, target, dimensions);
    getLogger().warn(`Embedding dimension migration restored missing ${target.table}.${target.column}`);
    return;
  }
  const legacy = `${target.column}_legacy_${current}_before_${dimensions}`;
  await requireLegacyColumnAbsent(pool, target.table, legacy);
  if (target.table === 'memory_chunks') await dropChunkVectorIndex(pool);
  await pool.query(`ALTER TABLE ${target.table} RENAME COLUMN ${target.column} TO ${legacy}`);
  await allowNullLegacy(pool, target.table, legacy);
  await addReplacementColumn(pool, target, dimensions);
  getLogger().warn(
    `Embedding dimension migration preserved ${target.table}.${legacy}; backfill ${target.table}.${target.column}`,
  );
}

async function addReplacementColumn(
  pool: DatabasePool,
  target: EmbeddingColumnTarget,
  dimensions: number,
): Promise<void> {
  await pool.query(`ALTER TABLE ${target.table} ADD COLUMN ${target.column} VECTOR(${dimensions})`);
  if (target.table === 'memory_chunks') await createChunkVectorIndex(pool);
}

async function columnDimensions(
  pool: DatabasePool,
  target: EmbeddingColumnTarget,
): Promise<number | null> {
  const result = await pool.query(
    `SELECT a.atttypmod AS dimensions
     FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = $1 AND a.attname = $2
       AND a.attnum > 0 AND NOT a.attisdropped`,
    [target.table, target.column],
  );
  const value = (result.rows[0] as { dimensions?: unknown } | undefined)?.dimensions;
  return value === undefined ? null : Number(value);
}

async function repairMisreadLegacy(
  pool: DatabasePool,
  target: EmbeddingColumnTarget,
  dimensions: number,
): Promise<void> {
  if (dimensions <= 4) return;
  const legacy = `${target.column}_legacy_${dimensions - 4}_before_${dimensions}`;
  const legacyDimensions = await columnDimensions(pool, { table: target.table, column: legacy });
  if (legacyDimensions !== dimensions) return;
  await pool.query(
    `UPDATE ${target.table} SET ${target.column} = ${legacy} WHERE ${target.column} IS NULL`,
  );
  await allowNullLegacy(pool, target.table, legacy);
  getLogger().warn(`Embedding dimension repair restored values from ${target.table}.${legacy}`);
}

function allowNullLegacy(pool: DatabasePool, table: string, column: string): Promise<void> {
  return pool.query(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP NOT NULL`).then(() => undefined);
}

async function requireLegacyColumnAbsent(
  pool: DatabasePool,
  table: string,
  column: string,
): Promise<void> {
  const result = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  if (result.rows.length > 0) {
    throw new Error(`Embedding migration target already exists: ${table}.${column}`);
  }
}

function dropChunkVectorIndex(pool: DatabasePool): Promise<void> {
  return pool.query('DROP INDEX IF EXISTS idx_memory_chunks_embedding_hnsw').then(() => undefined);
}

function createChunkVectorIndex(pool: DatabasePool): Promise<void> {
  return pool.query(
    `CREATE INDEX idx_memory_chunks_embedding_hnsw
     ON memory_chunks USING hnsw (embedding vector_cosine_ops)
     WITH (m = 16, ef_construction = 64)`,
  ).then(() => undefined);
}

function requireDimensions(dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error('Embedding migration dimensions must be a positive integer');
  }
}

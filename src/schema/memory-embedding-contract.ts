import type { DatabasePool } from '../types.js';

const EMBEDDING_COLUMNS = [
  { table: 'memories', column: 'embedding' },
  { table: 'memory_chunks', column: 'embedding' },
] as const;

export async function validateEmbeddingColumnContract(
  pool: DatabasePool,
  dimensions: number,
): Promise<void> {
  const expected = `vector(${dimensions})`;
  for (const target of EMBEDDING_COLUMNS) {
    const actual = await readColumnType(pool, target.table, target.column);
    if (actual !== expected) {
      throw new Error(
        `Embedding schema mismatch for ${target.table}.${target.column}: expected ${expected}, found ${actual ?? 'missing'}`,
      );
    }
  }
}

async function readColumnType(
  pool: DatabasePool,
  table: string,
  column: string,
): Promise<string | null> {
  const result = await pool.query(
    `SELECT format_type(a.atttypid, a.atttypmod) AS column_type
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = $1
       AND a.attname = $2
       AND a.attnum > 0
       AND NOT a.attisdropped`,
    [table, column],
  );
  const row = result.rows[0] as { column_type?: string } | undefined;
  return row?.column_type ?? null;
}

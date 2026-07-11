import type { DatabaseClient, DatabasePool } from '../types.js';
import { CoordinationPersistenceError } from './errors.js';

export function requireCoordinationPostgres(pool: DatabasePool): void {
  if (pool.getDialect?.() !== 'pg') {
    throw new CoordinationPersistenceError(
      'POSTGRES_REQUIRED',
      'Coordination persistence requires PostgreSQL',
    );
  }
}

export async function withCoordinationTransaction<T>(
  pool: DatabasePool,
  task: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  requireCoordinationPostgres(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await task(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function withCoordinationReadTransaction<T>(
  pool: DatabasePool,
  task: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  requireCoordinationPostgres(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await task(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

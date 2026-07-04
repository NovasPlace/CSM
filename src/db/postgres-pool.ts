import pg from 'pg';
import type { DatabasePool } from '../types.js';

const { Pool } = pg;

export function createPostgresPool(databaseUrl: string): Promise<DatabasePool> {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  const wrapped: DatabasePool = {
    async query(text: string, params?: unknown[]) {
      const result = await pool.query(text, params as unknown[]);
      return { rows: result.rows as unknown[], rowCount: result.rowCount ?? null };
    },
    async connect() {
      const client = await pool.connect();
      return {
        async query(text: string, params?: unknown[]) {
          const result = await client.query(text, params as unknown[]);
          return { rows: result.rows as unknown[], rowCount: result.rowCount ?? null };
        },
        release() {
          client.release();
        },
      };
     },
     async end() {
       await pool.end();
     },
     getDialect() {
       return 'pg';
     },
   };

  return Promise.resolve(wrapped);
}

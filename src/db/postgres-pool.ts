import pg from 'pg';
import type { PoolConfig } from 'pg';
import type { DatabasePool, DatabaseRuntimeConfig } from '../types.js';
import { DEFAULT_DATABASE_RUNTIME_CONFIG } from '../database-runtime-config.js';

const { Pool } = pg;

export function createPostgresPool(
  databaseUrl: string,
  runtime: DatabaseRuntimeConfig = DEFAULT_DATABASE_RUNTIME_CONFIG,
): Promise<DatabasePool> {
  const pool = new Pool(buildPostgresPoolConfig(databaseUrl, runtime));
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
        release(error?: Error) {
          client.release(error);
        },
      };
    },
    async end() {
      await pool.end();
    },
    getStats() {
      return {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount,
      };
    },
    getDialect() {
      return 'pg';
    },
  };
  return Promise.resolve(wrapped);
}

export function buildPostgresPoolConfig(
  databaseUrl: string,
  runtime: DatabaseRuntimeConfig,
): PoolConfig {
  return {
    connectionString: databaseUrlWithTlsPolicy(databaseUrl, runtime.tlsMode),
    max: runtime.maxConnections,
    idleTimeoutMillis: runtime.idleTimeoutMs,
    connectionTimeoutMillis: runtime.connectionTimeoutMs,
    statement_timeout: runtime.statementTimeoutMs || false,
  };
}

function databaseUrlWithTlsPolicy(
  databaseUrl: string,
  mode: DatabaseRuntimeConfig['tlsMode'],
): string {
  if (mode === 'url') return databaseUrl;
  const url = new URL(databaseUrl);
  const sslMode = mode === 'require' ? 'no-verify' : mode;
  url.searchParams.set('sslmode', sslMode);
  return url.toString();
}

import type { DatabasePool, DatabaseProvider, DatabaseRuntimeConfig } from '../types.js';
import { createPostgresPool } from './postgres-pool.js';

export type { DatabaseProvider } from '../types.js';

export interface PoolFactoryOptions {
  provider: DatabaseProvider;
  databaseUrl: string;
  sqlitePath: string;
  runtime?: DatabaseRuntimeConfig;
}

export async function createDatabasePool(options: PoolFactoryOptions): Promise<DatabasePool> {
  switch (options.provider) {
    case 'postgres':
      return createPostgresPool(options.databaseUrl, options.runtime);
    case 'sqlite': {
      const { createSqlitePool } = await import('./sqlite-pool.js');
      return createSqlitePool(options.sqlitePath);
    }
    default:
      throw new Error(`Unknown database provider: ${options.provider as string}`);
  }
}

export type { DatabasePool, DatabaseClient } from '../types.js';

import type { DatabasePool, PluginConfig } from './types.js';
import { createDatabasePool } from './db/database-pool.js';
import { initializeAllSchemas } from './schema/index.js';
import { getLogger } from './logger.js';
import type { QueryDialect } from './db/query-dialect.js';
import { dialectFromProvider } from './db/query-dialect.js';

export class Database {
  private pool: DatabasePool | null = null;
  private config: PluginConfig;
  readonly dialect: QueryDialect;

  constructor(config: PluginConfig) {
    this.config = config;
    this.dialect = dialectFromProvider(config.databaseProvider);
  }

  async connect(): Promise<void> {
    try {
      this.pool = await createDatabasePool({
        provider: this.config.databaseProvider,
        databaseUrl: this.config.databaseUrl,
        sqlitePath: this.config.sqlitePath,
      });

      const label = this.config.databaseProvider === 'sqlite' ? 'SQLite' : 'PostgreSQL';
      getLogger().info(`Connected to ${label}`);
      try {
        await this.initializeSchema();
      } catch (error) {
        getLogger().error('Schema initialization failed; continuing with existing database', error instanceof Error ? error : undefined);
      }
    } catch (error) {
      getLogger().error('Connection failed', error instanceof Error ? error : undefined);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.pool) return;
    await this.pool.end();
    this.pool = null;
    getLogger().info('Database disconnected');
  }

  private async initializeSchema(): Promise<void> {
    if (!this.pool) throw new Error('Database not connected');
    await initializeAllSchemas(this);
    getLogger().info('Schema initialized');
  }

  getPool(): DatabasePool {
    if (!this.pool) throw new Error('Database not connected');
    return this.pool;
  }

  getProvider(): string {
    return this.config.databaseProvider;
  }

  async close(): Promise<void> {
    if (!this.pool) return;
    await this.pool.end();
    this.pool = null;
  }
}

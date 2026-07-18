import type {
  DatabaseDiagnostics,
  DatabasePool,
  DatabaseStartupState,
  PluginConfig,
} from './types.js';
import { createDatabasePool } from './db/database-pool.js';
import { initializeAllSchemas } from './schema/index.js';
import { validateEmbeddingColumnContract } from './schema/memory-embedding-contract.js';
import { getLogger } from './logger.js';
import type { QueryDialect } from './db/query-dialect.js';
import { dialectFromProvider } from './db/query-dialect.js';
import { formatDatabaseDiagnostic } from './database-diagnostic.js';
import { RetryablePoolCloser } from './database-pool-closer.js';
import { EmbeddingGenerator } from './embeddings.js';
import { diagnoseDatabase } from './database-health.js';
export class Database {
  private pool: DatabasePool | null = null;
  private config: PluginConfig;
  private startupState: DatabaseStartupState = 'idle';
  private startupError?: string;
  private connectPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private readonly poolCloser = new RetryablePoolCloser();
  readonly dialect: QueryDialect;
  constructor(config: PluginConfig) {
    this.config = config;
    this.dialect = dialectFromProvider(config.databaseProvider);
  }
  async connect(): Promise<void> {
    if (this.closePromise) await this.closePromise;
    if (this.poolCloser.pending > 0) await this.shutdown(false);
    if (this.connectPromise) return this.connectPromise;
    const operation = this.ensureConnected();
    this.connectPromise = operation;
    try {
      await operation;
    } finally {
      if (this.connectPromise === operation) this.connectPromise = null;
    }
  }

  private async ensureConnected(): Promise<void> {
    if (await this.reuseHealthyPool()) return;
    this.startupState = 'connecting';
    this.startupError = undefined;
    let candidate: DatabasePool | null = null;
    try {
      candidate = await createDatabasePool({
        provider: this.config.databaseProvider,
        databaseUrl: this.config.databaseUrl,
        sqlitePath: this.config.sqlitePath,
        runtime: this.config.databaseRuntime,
      });
      await candidate.query('SELECT 1 AS healthy');
      this.pool = candidate;
      candidate = null;
      const label = this.config.databaseProvider === 'sqlite' ? 'SQLite' : 'PostgreSQL';
      getLogger().info(`Connected to ${label}`);
      this.startupState = 'migrating';
      await this.initializeSchema();
      this.startupState = 'ready';
    } catch (error) {
      this.startupState = 'failed';
      this.startupError = formatDatabaseDiagnostic(error);
      await this.closeFailedPool(candidate);
      getLogger().error('Database startup failed', error instanceof Error ? error : undefined);
      throw error;
    }
  }

  private async closeFailedPool(candidate: DatabasePool | null): Promise<void> {
    const failedPool = this.pool ?? candidate;
    if (!failedPool) return;
    if (this.pool === failedPool) this.pool = null;
    try {
      await failedPool.end();
    } catch {
      this.poolCloser.add(failedPool);
      // Preserve the original startup error.
    }
  }

  async disconnect(): Promise<void> {
    await this.shutdown(true);
  }

  private async initializeSchema(): Promise<void> {
    if (!this.pool) throw new Error('Database not connected');
    const embeddings = new EmbeddingGenerator(this.config);
    const dimensions = embeddings.getExpectedDimensions();
    await initializeAllSchemas(this, dimensions);
    if (this.pool.getDialect?.() === 'pg') {
      await validateEmbeddingColumnContract(this.pool, dimensions);
    }
    getLogger().info(`Schema initialized with embedding dimension ${dimensions}`);
  }

  getPool(): DatabasePool {
    if (!this.pool) throw new Error('Database not connected');
    return this.pool;
  }

  getProvider(): string {
    return this.config.databaseProvider;
  }

  async close(): Promise<void> {
    await this.shutdown(false);
  }

  private async shutdown(logDisconnect: boolean): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const operation = this.closeRuntime(logDisconnect);
    this.closePromise = operation;
    try {
      await operation;
    } finally {
      if (this.closePromise === operation) this.closePromise = null;
    }
  }

  private async reuseHealthyPool(): Promise<boolean> {
    if (!this.pool || this.startupState !== 'ready') return false;
    try {
      await this.pool.query('SELECT 1 AS healthy');
      return true;
    } catch {
      try {
        await this.detachPool();
      } catch (error) {
        this.startupState = 'failed';
        this.startupError = formatDatabaseDiagnostic(error);
        throw error;
      }
      return false;
    }
  }

  private async closeRuntime(logDisconnect: boolean): Promise<void> {
    if (this.connectPromise) await this.connectPromise.catch(() => undefined);
    if (this.pool) this.poolCloser.add(this.pool);
    this.pool = null;
    if (this.poolCloser.pending === 0) {
      this.startupState = 'closed';
      this.startupError = undefined;
      return;
    }
    try {
      await this.poolCloser.closeAll();
    } catch (error) {
      this.startupState = 'failed';
      this.startupError = formatDatabaseDiagnostic(error);
      throw error;
    }
    this.startupState = 'closed';
    this.startupError = undefined;
    if (logDisconnect) getLogger().info('Database disconnected');
  }

  private async detachPool(): Promise<void> {
    const stale = this.pool;
    this.pool = null;
    if (!stale) return;
    try {
      await stale.end();
    } catch (error) {
      this.poolCloser.add(stale);
      throw new Error('Failed to close unhealthy database pool', { cause: error });
    }
  }

  async diagnose(): Promise<DatabaseDiagnostics> {
    return diagnoseDatabase(
      this.pool,
      this.config.databaseProvider,
      this.startupState,
      this.startupError,
    );
  }
}

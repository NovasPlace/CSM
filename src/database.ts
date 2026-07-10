import type {
  DatabaseDiagnostics,
  DatabasePool,
  DatabaseStartupState,
  PluginConfig,
} from './types.js';
import { createDatabasePool } from './db/database-pool.js';
import { initializeAllSchemas } from './schema/index.js';
import { getLogger } from './logger.js';
import type { QueryDialect } from './db/query-dialect.js';
import { dialectFromProvider } from './db/query-dialect.js';

export class Database {
  private pool: DatabasePool | null = null;
  private config: PluginConfig;
  private startupState: DatabaseStartupState = 'idle';
  private startupError?: string;
  readonly dialect: QueryDialect;

  constructor(config: PluginConfig) {
    this.config = config;
    this.dialect = dialectFromProvider(config.databaseProvider);
  }

  async connect(): Promise<void> {
    this.startupState = 'connecting';
    this.startupError = undefined;
    try {
      this.pool = await createDatabasePool({
        provider: this.config.databaseProvider,
        databaseUrl: this.config.databaseUrl,
        sqlitePath: this.config.sqlitePath,
        runtime: this.config.databaseRuntime,
      });

      const label = this.config.databaseProvider === 'sqlite' ? 'SQLite' : 'PostgreSQL';
      getLogger().info(`Connected to ${label}`);
      this.startupState = 'migrating';
      await this.initializeSchema();
      this.startupState = 'ready';
    } catch (error) {
      this.startupState = 'failed';
      this.startupError = formatDiagnosticError(error);
      await this.closeFailedPool();
      getLogger().error('Database startup failed', error instanceof Error ? error : undefined);
      throw error;
    }
  }

  private async closeFailedPool(): Promise<void> {
    if (!this.pool) return;
    const failedPool = this.pool;
    this.pool = null;
    try {
      await failedPool.end();
    } catch {
      // Preserve the original startup error.
    }
  }

  async disconnect(): Promise<void> {
    if (!this.pool) return;
    await this.pool.end();
    this.pool = null;
    this.startupState = 'closed';
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
    if (this.pool) await this.pool.end();
    this.pool = null;
    this.startupState = 'closed';
  }

  async diagnose(): Promise<DatabaseDiagnostics> {
    const checkedAt = new Date().toISOString();
    const startedAt = performance.now();
    const readiness = await this.probeReadiness(startedAt);
    return {
      provider: this.config.databaseProvider,
      checkedAt,
      startup: { state: this.startupState, ...(this.startupError ? { error: this.startupError } : {}) },
      liveness: { status: 'pass' },
      readiness,
      ...(this.pool?.getStats ? { pool: this.pool.getStats() } : {}),
    };
  }

  private async probeReadiness(startedAt: number): Promise<DatabaseDiagnostics['readiness']> {
    if (!this.pool || this.startupState !== 'ready') {
      return { status: 'fail', latencyMs: elapsedMs(startedAt), reason: 'not_connected' };
    }
    try {
      await this.pool.query('SELECT 1 AS healthy');
      return { status: 'pass', latencyMs: elapsedMs(startedAt) };
    } catch (error) {
      return {
        status: 'fail',
        latencyMs: elapsedMs(startedAt),
        reason: 'probe_failed',
        error: formatDiagnosticError(error),
      };
    }
  }
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
}

function formatDiagnosticError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

import type { DatabaseProvider, PluginConfig } from './types.js';
import { databaseRuntimeConfigFromEnv } from './database-runtime-config.js';
import { getEnvBoolean, getEnvString } from './config-env.js';

type DatabaseSettings = Pick<PluginConfig,
  'databaseProvider' | 'databaseUrl' | 'sqlitePath' | 'databaseRuntime'>;
type EmbeddingSettings = Pick<PluginConfig,
  'embeddingModel' | 'embeddingApiKey' | 'embeddingApiUrl'>;

const DEFAULT_DATABASE_URL =
  'postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory';
const DEFAULT_SQLITE_PATH = '.data/csm-memory.db';

export function databaseSettingsFromEnv(): DatabaseSettings {
  const databaseProvider = readDatabaseProvider();
  const sqlitePath = databaseProvider === 'sqlite' ? readSqlitePath() : DEFAULT_SQLITE_PATH;
  const explicitUrl = getEnvString('CSM_DATABASE_URL');
  const requireExplicit = getEnvBoolean('CSM_REQUIRE_EXPLICIT_DATABASE_URL', false);
  if (databaseProvider === 'postgres' && requireExplicit && !explicitUrl) {
    throw new Error('CSM_DATABASE_URL is required in production mode');
  }
  const databaseUrl = explicitUrl || DEFAULT_DATABASE_URL;
  if (databaseProvider === 'postgres') validatePostgresUrl(databaseUrl);
  const databaseRuntime = databaseProvider === 'postgres' ? databaseRuntimeConfigFromEnv() : undefined;
  return { databaseProvider, databaseUrl, sqlitePath, databaseRuntime };
}

export function embeddingSettingsFromEnv(): EmbeddingSettings {
  const provider = getEnvString('CSM_EMBEDDING_PROVIDER', 'ollama');
  if (provider === 'openai') {
    const embeddingApiKey = getEnvString('OPENAI_API_KEY');
    if (!embeddingApiKey?.trim()) {
      throw new Error('OPENAI_API_KEY is required when CSM_EMBEDDING_PROVIDER=openai');
    }
    return { embeddingModel: 'text-embedding-3-small', embeddingApiKey };
  }
  if (provider !== 'ollama') {
    throw new Error(`Invalid CSM_EMBEDDING_PROVIDER: "${provider}". Must be "ollama" or "openai"`);
  }
  const embeddingApiUrl = getEnvString('OLLAMA_HOST', 'http://localhost:11434') as string;
  validateHttpUrl('OLLAMA_HOST', embeddingApiUrl);
  return { embeddingModel: 'nomic-embed-text', embeddingApiUrl };
}

export function validateDatabaseTarget(config: PluginConfig): void {
  if (config.databaseProvider !== 'postgres' && config.databaseProvider !== 'sqlite') {
    throw new Error(`Invalid databaseProvider: "${String(config.databaseProvider)}"`);
  }
  if (config.databaseProvider === 'postgres') validatePostgresUrl(config.databaseUrl);
  if (config.databaseProvider === 'sqlite'
    && (!config.sqlitePath.trim() || config.sqlitePath.includes('\0'))) {
    throw new Error('sqlitePath must be a non-empty path without NUL characters');
  }
}

function readDatabaseProvider(): DatabaseProvider {
  const provider = getEnvString('CSM_DATABASE_PROVIDER', 'postgres');
  if (provider === 'postgres' || provider === 'sqlite') return provider;
  throw new Error(`Invalid CSM_DATABASE_PROVIDER: "${provider}". Must be "postgres" or "sqlite"`);
}

function readSqlitePath(): string {
  const path = getEnvString('CSM_SQLITE_PATH', DEFAULT_SQLITE_PATH) as string;
  if (!path.trim() || path.includes('\0')) {
    throw new Error('CSM_SQLITE_PATH must be a non-empty path without NUL characters');
  }
  return path;
}

function validatePostgresUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('CSM_DATABASE_URL must be a valid PostgreSQL URL'); }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('CSM_DATABASE_URL must use the postgres or postgresql scheme');
  }
}

function validateHttpUrl(key: string, value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${key} must be a valid HTTP URL`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${key} must use the http or https scheme`);
  }
}

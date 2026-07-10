import type { DatabaseRuntimeConfig, DatabaseTlsMode } from './types.js';

export const DEFAULT_DATABASE_RUNTIME_CONFIG: DatabaseRuntimeConfig = {
  maxConnections: 20,
  connectionTimeoutMs: 5_000,
  statementTimeoutMs: 0,
  idleTimeoutMs: 30_000,
  tlsMode: 'url',
};

export function databaseRuntimeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DatabaseRuntimeConfig {
  const defaults = DEFAULT_DATABASE_RUNTIME_CONFIG;
  const config = {
    maxConnections: readInteger(env, 'CSM_DB_POOL_MAX', defaults.maxConnections),
    connectionTimeoutMs: readInteger(env, 'CSM_DB_CONNECTION_TIMEOUT_MS', defaults.connectionTimeoutMs),
    statementTimeoutMs: readInteger(env, 'CSM_DB_STATEMENT_TIMEOUT_MS', defaults.statementTimeoutMs),
    idleTimeoutMs: readInteger(env, 'CSM_DB_IDLE_TIMEOUT_MS', defaults.idleTimeoutMs),
    tlsMode: readTlsMode(env.CSM_DB_TLS_MODE),
  };
  validateDatabaseRuntimeConfig(config);
  return config;
}

export function validateDatabaseRuntimeConfig(config: DatabaseRuntimeConfig): void {
  assertRange('maxConnections', config.maxConnections, 1, 1_000);
  assertRange('connectionTimeoutMs', config.connectionTimeoutMs, 100, 300_000);
  assertRange('statementTimeoutMs', config.statementTimeoutMs, 0, 3_600_000);
  assertRange('idleTimeoutMs', config.idleTimeoutMs, 1_000, 3_600_000);
  readTlsMode(config.tlsMode);
}

function readInteger(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be an integer`);
  return Number(raw);
}

function readTlsMode(value: string | undefined): DatabaseTlsMode {
  const mode = value ?? DEFAULT_DATABASE_RUNTIME_CONFIG.tlsMode;
  if (mode === 'url' || mode === 'disable' || mode === 'require' || mode === 'verify-full') return mode;
  throw new Error(`CSM_DB_TLS_MODE must be url, disable, require, or verify-full`);
}

function assertRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`databaseRuntime.${name} must be an integer between ${min} and ${max}`);
  }
}

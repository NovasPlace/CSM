import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
  databaseRuntimeConfigFromEnv,
  DEFAULT_DATABASE_RUNTIME_CONFIG,
  validateDatabaseRuntimeConfig,
} from '../src/database-runtime-config.js';
import { buildPostgresPoolConfig } from '../src/db/postgres-pool.js';

it('uses behavior-preserving database runtime defaults', () => {
  assert.deepEqual(databaseRuntimeConfigFromEnv({}), DEFAULT_DATABASE_RUNTIME_CONFIG);
  const pool = buildPostgresPoolConfig('postgresql://localhost/csm', DEFAULT_DATABASE_RUNTIME_CONFIG);
  assert.equal(pool.max, 20);
  assert.equal(pool.statement_timeout, false);
  assert.equal(pool.connectionString, 'postgresql://localhost/csm');
});

it('parses pool, timeout, and TLS controls from the environment', () => {
  const config = databaseRuntimeConfigFromEnv({
    CSM_DB_POOL_MAX: '40',
    CSM_DB_CONNECTION_TIMEOUT_MS: '7000',
    CSM_DB_STATEMENT_TIMEOUT_MS: '45000',
    CSM_DB_IDLE_TIMEOUT_MS: '60000',
    CSM_DB_TLS_MODE: 'verify-full',
  });
  const pool = buildPostgresPoolConfig('postgresql://localhost/csm', config);
  assert.equal(pool.max, 40);
  assert.equal(pool.connectionTimeoutMillis, 7000);
  assert.equal(pool.statement_timeout, 45000);
  assert.match(String(pool.connectionString), /sslmode=verify-full/);
});

it('supports encrypted TLS without certificate verification only when explicit', () => {
  const config = { ...DEFAULT_DATABASE_RUNTIME_CONFIG, tlsMode: 'require' as const };
  const pool = buildPostgresPoolConfig('postgresql://localhost/csm', config);
  assert.match(String(pool.connectionString), /sslmode=no-verify/);
});

it('rejects malformed and out-of-range database controls', () => {
  assert.throws(
    () => databaseRuntimeConfigFromEnv({ CSM_DB_POOL_MAX: 'many' }),
    /CSM_DB_POOL_MAX must be an integer/,
  );
  assert.throws(
    () => validateDatabaseRuntimeConfig({ ...DEFAULT_DATABASE_RUNTIME_CONFIG, maxConnections: 0 }),
    /maxConnections/,
  );
  assert.throws(
    () => databaseRuntimeConfigFromEnv({ CSM_DB_TLS_MODE: 'prefer' }),
    /CSM_DB_TLS_MODE/,
  );
});

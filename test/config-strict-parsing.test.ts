import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getEnvBoolean,
  getEnvInteger,
  getEnvNumber,
  loadDotEnv,
  parseDotEnv,
} from '../dist/config-env.js';

const TEMP_DIRS: string[] = [];

afterEach(() => {
  for (const path of TEMP_DIRS.splice(0)) rmSync(path, { recursive: true, force: true });
});

it('parses supported dotenv syntax deterministically', () => {
  assert.deepEqual(parseDotEnv([
    '# comment', 'export ALPHA=one', 'QUOTED="two # literal"', "SINGLE='three'", 'INLINE=four # note',
  ].join('\n')), { ALPHA: 'one', QUOTED: 'two # literal', SINGLE: 'three', INLINE: 'four' });
});

it('stops quoted values at the first unescaped closing quote before comments', () => {
  assert.deepEqual(parseDotEnv([
    'DOUBLE="abc" # operator said "rotate"',
    "SINGLE='abc' # user's token",
    'ESCAPED="abc\\"def" # retained escape',
  ].join('\n')), { DOUBLE: 'abc', SINGLE: 'abc', ESCAPED: 'abc\\"def' });
});

it('rejects malformed dotenv records without exposing values', () => {
  assert.throws(() => parseDotEnv('MISSING_SEPARATOR'), /Invalid \.env line 1: expected KEY=VALUE/);
  assert.throws(() => parseDotEnv('BAD-KEY=value'), /invalid variable name/);
  assert.throws(() => parseDotEnv('SECRET="sensitive'), /unterminated quoted value/);
});

it('rejects invalid booleans instead of silently treating them as false', () => {
  assert.equal(getEnvBoolean('FLAG', false, { FLAG: 'TRUE' }), true);
  assert.equal(getEnvBoolean('FLAG', true, { FLAG: 'false' }), false);
  assert.throws(() => getEnvBoolean('FLAG', false, { FLAG: 'yes' }), /FLAG must be true or false/);
});

it('preserves finite decimals and rejects malformed or fractional integers', () => {
  assert.equal(getEnvNumber('THRESHOLD', 0, { THRESHOLD: '0.35' }), 0.35);
  assert.equal(getEnvNumber('THRESHOLD', 0, { THRESHOLD: '2e-1' }), 0.2);
  assert.throws(() => getEnvNumber('THRESHOLD', 0, { THRESHOLD: '12oops' }), /finite number/);
  assert.throws(() => getEnvInteger('COUNT', 0, { COUNT: '3.5' }), /COUNT must be an integer/);
});

it('fails clearly when a present dotenv file is malformed', () => {
  const directory = tempDirectory();
  writeFileSync(join(directory, '.env'), 'BROKEN', 'utf8');
  assert.throws(() => loadDotEnv(directory, {}), /Invalid \.env line 1/);
});

it('builds decimal thresholds exactly from environment input', async () => {
  const config = await importConfig({ CSM_IMPORTANCE_THRESHOLD: '0.35' });
  assert.equal(config.DEFAULT_CONFIG.importanceThreshold, 0.35);
});

it('rejects invalid startup booleans, numbers, and provider prerequisites', async () => {
  await assert.rejects(importConfig({ CSM_REENTRY_ENABLED: 'sometimes' }), /must be true or false/);
  await assert.rejects(importConfig({ CSM_TARGET_CONTEXT_CAP: '50000tokens' }), /finite number/);
  await assert.rejects(importConfig({ CSM_EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: undefined }),
    /OPENAI_API_KEY is required/);
  await assert.rejects(importConfig({ CSM_EMBEDDING_DIMENSIONS: '0' }),
    /CSM_EMBEDDING_DIMENSIONS must be greater than zero/);
});

it('uses provider-specific embedding dimensions unless explicitly configured', async () => {
  const ollama = await importConfig({ CSM_EMBEDDING_PROVIDER: 'ollama', CSM_EMBEDDING_DIMENSIONS: undefined });
  assert.equal(ollama.DEFAULT_CONFIG.embeddingDimensions, 768);
  const openai = await importConfig({
    CSM_EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key', CSM_EMBEDDING_DIMENSIONS: undefined,
  });
  assert.equal(openai.DEFAULT_CONFIG.embeddingDimensions, 1536);
  const explicit = await importConfig({ CSM_EMBEDDING_DIMENSIONS: '1024' });
  assert.equal(explicit.DEFAULT_CONFIG.embeddingDimensions, 1024);
});

it('requires an explicit PostgreSQL URL only in strict PostgreSQL mode', async () => {
  await assert.rejects(importConfig({ CSM_DATABASE_PROVIDER: 'postgres',
    CSM_REQUIRE_EXPLICIT_DATABASE_URL: 'true', CSM_DATABASE_URL: undefined }),
  /CSM_DATABASE_URL is required/);
  const config = await importConfig({ CSM_DATABASE_PROVIDER: 'sqlite', CSM_SQLITE_PATH: ':memory:',
    CSM_REQUIRE_EXPLICIT_DATABASE_URL: 'true', CSM_DATABASE_URL: undefined });
  assert.equal(config.DEFAULT_CONFIG.databaseProvider, 'sqlite');
});

it('ignores PostgreSQL pool controls for SQLite but validates them for PostgreSQL', async () => {
  const sqlite = await importConfig({ CSM_DATABASE_PROVIDER: 'sqlite', CSM_SQLITE_PATH: ':memory:',
    CSM_DB_TLS_MODE: 'invalid' });
  assert.equal(sqlite.DEFAULT_CONFIG.databaseRuntime, undefined);
  await assert.rejects(importConfig({ CSM_DATABASE_PROVIDER: 'postgres', CSM_DB_TLS_MODE: 'invalid' }),
    /CSM_DB_TLS_MODE/);
});

it('ignores SQLite paths for PostgreSQL but validates them for SQLite', async () => {
  const postgres = await importConfig({ CSM_DATABASE_PROVIDER: 'postgres', CSM_SQLITE_PATH: '   ' });
  assert.equal(postgres.DEFAULT_CONFIG.sqlitePath, '.data/csm-memory.db');
  await assert.rejects(importConfig({ CSM_DATABASE_PROVIDER: 'sqlite', CSM_SQLITE_PATH: '   ' }),
    /CSM_SQLITE_PATH must be a non-empty path/);
});

it('rejects unsafe values across interval, size, and output-limit families', async () => {
  await assertInvalidConfig('CSM_SELF_MODEL_UPDATE_INTERVAL', '-1', /selfModel\.updateIntervalMs/);
  await assertInvalidConfig('CSM_LIVING_STATE_INTERVAL', '0', /livingState\.updateIntervalMs/);
  await assertInvalidConfig('CSM_COMPACTOR_MAX_OUTPUT', '-1', /compactor\.maxOutputChars/);
  await assertInvalidConfig('CSM_CHECKPOINT_MAX_BYTES', '0', /checkpoint\.maxRawCaptureBytes/);
  await assertInvalidConfig('CSM_TTL_DEFAULT_DAYS', '366', /ttl\.defaultDays/);
});

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'csm-config-'));
  TEMP_DIRS.push(directory);
  return directory;
}

async function importConfig(overrides: Record<string, string | undefined>) {
  const originalCwd = process.cwd();
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try {
    process.chdir(tempDirectory());
    const url = pathToFileURL(join(originalCwd, 'dist', 'config.js'));
    return await import(`${url.href}?strict=${Date.now()}-${Math.random()}`);
  } finally {
    process.chdir(originalCwd);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

async function assertInvalidConfig(key: string, value: string, pattern: RegExp): Promise<void> {
  const config = await importConfig({ [key]: value });
  assert.throws(() => config.validateAndReturnConfig(), pattern);
}

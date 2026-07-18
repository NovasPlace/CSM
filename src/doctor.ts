import SqliteDatabase from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from './database.js';
import { createPostgresPool } from './db/postgres-pool.js';
import { EmbeddingGenerator } from './embeddings.js';
import { formatDatabaseDiagnostic } from './database-diagnostic.js';
import { buildPostgresMigrations } from './schema/postgres-migrations.js';
import { buildSqliteMigrations } from './schema/sqlite-migrations.js';
import {
  readMigrationHistory,
  validateMigrationHistory,
  type AppliedMigration,
  type SchemaMigration,
} from './schema/migration-ledger.js';
import type { RuntimePluginConfig } from './runtime-plugin-config.js';
import type { DatabasePool } from './types.js';

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail' | 'skip';
export type DoctorOverallStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  id: 'runtime' | 'package' | 'configuration' | 'security' | 'database' | 'schema' | 'embeddings';
  status: DoctorCheckStatus;
  summary: string;
  details?: Record<string, boolean | number | string>;
  action?: string;
}

export interface DoctorReport {
  schemaVersion: 1;
  product: 'Cross-Session Memory';
  version: string;
  checkedAt: string;
  overall: DoctorOverallStatus;
  onlineProbe: boolean;
  checks: DoctorCheck[];
  privacy: 'No credentials or memory content are included in this report.';
}

export interface DoctorOptions {
  cwd?: string;
  online?: boolean;
  nodeVersion?: string;
  loadConfig?: () => Promise<RuntimePluginConfig>;
}

interface PackageInfo {
  version?: unknown;
  main?: unknown;
  bin?: Record<string, unknown>;
}

const PACKAGE_ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const REQUIRED_PACKAGE_FILES = [
  'dist/index.js',
  'dist/cli/init-db.js',
  'dist/cli/doctor.js',
  '.codex-plugin/plugin.json',
  '.mcp.json',
] as const;
const EMBEDDING_PROBE_TIMEOUT_MS = 5_000;

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const online = options.online ?? false;
  const packageResult = inspectPackage();
  const checks: DoctorCheck[] = [
    inspectRuntime(options.nodeVersion ?? process.versions.node),
    packageResult.check,
  ];

  let config: RuntimePluginConfig;
  try {
    config = await (options.loadConfig ?? loadRuntimeConfig)();
    checks.push(configurationCheck(config));
    checks.push(securityCheck(config));
  } catch (error) {
    checks.push({
      id: 'configuration',
      status: 'fail',
      summary: 'Configuration is invalid.',
      action: 'Correct the named setting in .env, then run csm-doctor again.',
      details: { error: redactDoctorError(error) },
    });
    checks.push(skippedCheck('security', 'Security posture was not evaluated because configuration failed.'));
    checks.push(skippedCheck('database', 'Database was not checked because configuration failed.'));
    checks.push(skippedCheck('schema', 'Schema was not checked because configuration failed.'));
    checks.push(skippedCheck('embeddings', 'Embedding provider was not checked because configuration failed.'));
    return buildReport(packageResult.version, online, checks);
  }

  checks.push(...await inspectDatabase(config, cwd));
  checks.push(await inspectEmbeddings(config, online));
  return buildReport(packageResult.version, online, checks);
}

export function inspectRuntime(version: string): DoctorCheck {
  const supported = isSupportedNodeVersion(version);
  return supported
    ? {
      id: 'runtime',
      status: 'pass',
      summary: `Node.js ${version} is supported.`,
      details: { node: version },
    }
    : {
      id: 'runtime',
      status: 'fail',
      summary: `Node.js ${version} is outside CSM's supported runtime range.`,
      action: 'Install Node.js 22.22.2+, 24.15.0+, or 26+.',
      details: { node: version, required: '^22.22.2 || ^24.15.0 || >=26.0.0' },
    };
}

export function isSupportedNodeVersion(version: string): boolean {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major >= 26) return true;
  if (major === 24) return minor > 15 || (minor === 15 && patch >= 0);
  if (major === 22) return minor > 22 || (minor === 22 && patch >= 2);
  return false;
}

export function reportOverall(checks: readonly DoctorCheck[]): DoctorOverallStatus {
  if (checks.some((check) => check.status === 'fail')) return 'fail';
  if (checks.some((check) => check.status === 'warn')) return 'warn';
  return 'pass';
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `CSM Doctor ${report.version}: ${report.overall.toUpperCase()}`,
    '',
  ];
  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.summary}`);
    if (check.action) lines.push(`       Next: ${check.action}`);
  }
  lines.push('', report.privacy);
  return `${lines.join('\n')}\n`;
}

export function redactDoctorError(error: unknown, env: NodeJS.ProcessEnv = process.env): string {
  let message = formatDatabaseDiagnostic(error);
  for (const key of ['CSM_DATABASE_URL', 'OPENAI_API_KEY', 'OLLAMA_HOST'] as const) {
    const value = env[key];
    if (value && value.length >= 4) message = message.replaceAll(value, '[REDACTED]');
  }
  return message
    .replace(/((?:https?):\/\/)[^@\s/]+@/giu, '$1[REDACTED]@')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/giu, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret)\s*[=:]\s*)[^\s,;]+/giu, '$1[REDACTED]');
}

async function loadRuntimeConfig(): Promise<RuntimePluginConfig> {
  const { validateAndReturnConfig } = await import('./config.js');
  return validateAndReturnConfig();
}

function inspectPackage(): { check: DoctorCheck; version: string } {
  try {
    const packageInfo = JSON.parse(
      readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8'),
    ) as PackageInfo;
    const version = typeof packageInfo.version === 'string' ? packageInfo.version : 'unknown';
    const missing = REQUIRED_PACKAGE_FILES.filter((path) => !existsSync(resolve(PACKAGE_ROOT, path)));
    const manifestReady = packageInfo.main === 'dist/index.js'
      && packageInfo.bin?.['csm-init'] === 'dist/cli/init-db.js'
      && packageInfo.bin?.['csm-doctor'] === 'dist/cli/doctor.js';
    if (missing.length === 0 && manifestReady) {
      return {
        version,
        check: {
          id: 'package', status: 'pass', summary: `Package ${version} contains its runtime and host adapters.`,
          details: { version, requiredFiles: REQUIRED_PACKAGE_FILES.length },
        },
      };
    }
    return {
      version,
      check: {
        id: 'package', status: 'fail', summary: 'Package contents are incomplete or inconsistent.',
        action: 'Reinstall CSM from a verified release package.',
        details: { version, missingFiles: missing.join(', ') || 'manifest entry mismatch' },
      },
    };
  } catch (error) {
    return {
      version: 'unknown',
      check: {
        id: 'package', status: 'fail', summary: 'Package metadata could not be read.',
        action: 'Reinstall CSM from a verified release package.',
        details: { error: redactDoctorError(error) },
      },
    };
  }
}

function configurationCheck(config: RuntimePluginConfig): DoctorCheck {
  const provider = config.embeddingApiKey ? 'openai' : config.embeddingApiUrl ? 'ollama' : 'hash';
  return {
    id: 'configuration',
    status: 'pass',
    summary: `Configuration is valid for ${config.databaseProvider} with ${provider} embeddings.`,
    details: {
      databaseProvider: config.databaseProvider,
      embeddingProvider: provider,
      embeddingModel: config.embeddingModel,
      embeddingDimensions: config.embeddingDimensions ?? (provider === 'ollama' ? 768 : 1_536),
      retentionEnabled: config.ttl.enabled,
      fullTranscripts: config.fullTranscripts,
    },
  };
}

function securityCheck(config: RuntimePluginConfig): DoctorCheck {
  const actions: string[] = [];
  if (!config.ttl.enabled) actions.push('enable TTL retention or document an external deletion policy');
  if (config.databaseProvider === 'postgres') {
    if (!process.env.CSM_DATABASE_URL) actions.push('set an explicit CSM_DATABASE_URL');
    const tlsMode = config.databaseRuntime?.tlsMode ?? 'url';
    if (tlsMode === 'disable') actions.push('enable PostgreSQL TLS for non-local deployments');
    if (tlsMode === 'url' && isRemotePostgresWithoutTls(config.databaseUrl)) {
      actions.push('set CSM_DB_TLS_MODE=verify-full for the remote database');
    }
  }
  if (actions.length > 0) {
    return {
      id: 'security', status: 'warn', summary: 'The configuration is usable but needs production hardening.',
      action: `${actions.join('; ')}.`,
      details: { findings: actions.length },
    };
  }
  return {
    id: 'security', status: 'pass', summary: 'Configured storage and retention controls meet the baseline checks.',
    details: { retentionEnabled: config.ttl.enabled },
  };
}

function isRemotePostgresWithoutTls(databaseUrl: string): boolean {
  try {
    const url = new URL(databaseUrl);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
    return !local && !url.searchParams.has('sslmode');
  } catch {
    return false;
  }
}

async function inspectDatabase(config: RuntimePluginConfig, cwd: string): Promise<DoctorCheck[]> {
  if (config.databaseProvider === 'sqlite') return inspectSqliteDatabase(config, cwd);
  return inspectPostgresDatabase(config);
}

async function inspectSqliteDatabase(
  config: RuntimePluginConfig,
  cwd: string,
): Promise<DoctorCheck[]> {
  const databasePath = isAbsolute(config.sqlitePath) ? config.sqlitePath : resolve(cwd, config.sqlitePath);
  if (config.sqlitePath === ':memory:' || !existsSync(databasePath)) {
    return [
      {
        id: 'database', status: 'fail', summary: 'The configured SQLite database does not exist.',
        action: 'Run csm-init once from the project directory, then rerun csm-doctor.',
      },
      skippedCheck('schema', 'Schema was not checked because the SQLite database is unavailable.'),
    ];
  }

  let sqlite: SqliteDatabase.Database | undefined;
  try {
    sqlite = new SqliteDatabase(databasePath, { readonly: true, fileMustExist: true });
    const pool = readOnlySqlitePool(sqlite);
    const startedAt = performance.now();
    await pool.query('SELECT 1 AS healthy');
    const databaseCheck: DoctorCheck = {
      id: 'database', status: 'pass', summary: 'SQLite is reachable in read-only diagnostic mode.',
      details: { provider: 'sqlite', latencyMs: elapsedMs(startedAt) },
    };
    return [databaseCheck, await inspectSchema(config, pool)];
  } catch (error) {
    return [
      {
        id: 'database', status: 'fail', summary: 'SQLite could not be opened or queried.',
        action: 'Check file permissions and confirm no damaged database file is being used.',
        details: { error: redactDoctorError(error) },
      },
      skippedCheck('schema', 'Schema was not checked because SQLite was unavailable.'),
    ];
  } finally {
    try { sqlite?.close(); } catch { /* retain the completed diagnostic report */ }
  }
}

async function inspectPostgresDatabase(config: RuntimePluginConfig): Promise<DoctorCheck[]> {
  let pool: DatabasePool | undefined;
  try {
    pool = await createPostgresPool(config.databaseUrl, config.databaseRuntime);
    const startedAt = performance.now();
    await pool.query('SELECT 1 AS healthy');
    const databaseCheck: DoctorCheck = {
      id: 'database', status: 'pass', summary: 'PostgreSQL is reachable.',
      details: { provider: 'postgres', latencyMs: elapsedMs(startedAt) },
    };
    return [databaseCheck, await inspectSchema(config, pool)];
  } catch (error) {
    return [
      {
        id: 'database', status: 'fail', summary: 'PostgreSQL could not be reached.',
        action: 'Check the database service, URL, network policy, credentials, and TLS settings.',
        details: { error: redactDoctorError(error) },
      },
      skippedCheck('schema', 'Schema was not checked because PostgreSQL was unavailable.'),
    ];
  } finally {
    await pool?.end().catch(() => undefined);
  }
}

async function inspectSchema(config: RuntimePluginConfig, pool: DatabasePool): Promise<DoctorCheck> {
  try {
    const applied = await readMigrationHistory(pool);
    const migrations = expectedMigrations(config, pool);
    validateMigrationHistory(migrations, applied, config.databaseProvider);
    assertAllMigrationsApplied(migrations, applied);
    return {
      id: 'schema', status: 'pass', summary: `Schema history is current (${applied.length} migrations).`,
      details: { appliedMigrations: applied.length, latestMigration: migrations.at(-1)?.id ?? 'none' },
    };
  } catch (error) {
    return {
      id: 'schema', status: 'fail', summary: 'Database schema is missing, outdated, or incompatible.',
      action: 'Back up the database, run csm-init with this CSM version, then rerun csm-doctor.',
      details: { error: redactDoctorError(error) },
    };
  }
}

function expectedMigrations(config: RuntimePluginConfig, pool: DatabasePool): SchemaMigration[] {
  if (config.databaseProvider === 'sqlite') return buildSqliteMigrations(pool);
  return buildPostgresMigrations(new Database(config), pool, config.embeddingDimensions ?? 1_536);
}

function assertAllMigrationsApplied(
  migrations: readonly SchemaMigration[],
  applied: readonly AppliedMigration[],
): void {
  const appliedIds = new Set(applied.map((migration) => migration.id));
  const missing = migrations.filter((migration) => !appliedIds.has(migration.id));
  if (missing.length > 0) throw new Error(`Missing migrations: ${missing.map((item) => item.id).join(', ')}`);
}

async function inspectEmbeddings(
  config: RuntimePluginConfig,
  online: boolean,
): Promise<DoctorCheck> {
  const generator = new EmbeddingGenerator(config);
  const info = generator.getProviderInfo();
  if (!online) {
    return {
      id: 'embeddings', status: 'skip', summary: `${info.provider} embedding configuration is valid; connectivity was not probed.`,
      action: 'Run csm-doctor --online to verify the configured embedding model and vector dimensions.',
      details: { provider: info.provider, model: info.model, expectedDimensions: generator.getExpectedDimensions() },
    };
  }
  try {
    const dimensions = await probeEmbeddingProvider(config, generator);
    return {
      id: 'embeddings', status: 'pass', summary: `${info.provider} embeddings responded with ${dimensions} dimensions.`,
      details: { provider: info.provider, model: info.model, dimensions },
    };
  } catch (error) {
    return {
      id: 'embeddings', status: 'fail', summary: `${info.provider} embeddings could not complete a probe.`,
      action: 'Check provider availability, credentials, model installation, and configured dimensions.',
      details: { error: redactDoctorError(error), timeoutMs: EMBEDDING_PROBE_TIMEOUT_MS },
    };
  }
}

async function probeEmbeddingProvider(
  config: RuntimePluginConfig,
  generator: EmbeddingGenerator,
): Promise<number> {
  const info = generator.getProviderInfo();
  if (info.provider === 'hash') return generator.probeDimensions();
  const expectedDimensions = generator.getExpectedDimensions();
  const signal = AbortSignal.timeout(EMBEDDING_PROBE_TIMEOUT_MS);
  let response: Response;
  let vector: unknown;
  if (info.provider === 'ollama') {
    const baseUrl = (config.embeddingApiUrl ?? 'http://localhost:11434').replace(/\/+$/u, '');
    response = await fetch(`${baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: info.model, prompt: 'probe' }),
      signal,
    });
    requireProbeResponse(response, 'Ollama');
    vector = (await response.json() as { embedding?: unknown }).embedding;
  } else {
    const baseUrl = (config.embeddingApiUrl ?? 'https://api.openai.com/v1').replace(/\/+$/u, '');
    response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.embeddingApiKey ?? ''}`,
      },
      body: JSON.stringify({ model: info.model, input: 'probe', dimensions: expectedDimensions }),
      signal,
    });
    requireProbeResponse(response, 'OpenAI');
    vector = (await response.json() as { data?: Array<{ embedding?: unknown }> }).data?.[0]?.embedding;
  }
  if (!Array.isArray(vector) || !vector.every(Number.isFinite)) {
    throw new Error(`${info.provider} embedding response did not contain a finite numeric vector`);
  }
  if (vector.length !== expectedDimensions) {
    throw new Error(`${info.provider} embedding dimension mismatch: expected ${expectedDimensions}, received ${vector.length}`);
  }
  return vector.length;
}

function requireProbeResponse(response: Response, provider: string): void {
  if (!response.ok) throw new Error(`${provider} embedding API error: ${response.status} ${response.statusText}`);
}

function readOnlySqlitePool(sqlite: SqliteDatabase.Database): DatabasePool {
  return {
    async query(text: string, params: unknown[] = []) {
      const statement = sqlite.prepare(text);
      if (!statement.reader) throw new Error('CSM Doctor refused a non-read-only SQLite statement');
      const rows = params.length > 0 ? statement.all(...params) : statement.all();
      return { rows: rows as unknown[], rowCount: rows.length };
    },
    async connect() {
      throw new Error('CSM Doctor does not acquire SQLite write transactions');
    },
    async end() {},
    getDialect: () => 'sqlite',
  };
}

function skippedCheck(id: DoctorCheck['id'], summary: string): DoctorCheck {
  return { id, status: 'skip', summary };
}

function buildReport(
  version: string,
  onlineProbe: boolean,
  checks: DoctorCheck[],
): DoctorReport {
  return {
    schemaVersion: 1,
    product: 'Cross-Session Memory',
    version,
    checkedAt: new Date().toISOString(),
    overall: reportOverall(checks),
    onlineProbe,
    checks,
    privacy: 'No credentials or memory content are included in this report.',
  };
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
}

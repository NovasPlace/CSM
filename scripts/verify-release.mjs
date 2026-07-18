import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';

const baseUrl = requireReleaseDatabaseUrl();
const databaseName = `csm_release_verify_${Date.now()}_${process.pid}`;
const admin = new Pool({ connectionString: databaseUrl(baseUrl, 'postgres') });
let created = false;
let operationError;

try {
  await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  created = true;

  const testEnv = { ...process.env, CSM_DATABASE_URL: databaseUrl(baseUrl, databaseName) };
  delete testEnv.DATABASE_URL;
  runNpmScript('build', testEnv);
  runNpmScript('db:setup', testEnv);
  runNpmScript('verify', testEnv);
  runNpmScript('lint:src', testEnv);

  const drillEnv = { ...process.env, CSM_BACKUP_DRILL_DATABASE_URL: baseUrl };
  delete drillEnv.CSM_DATABASE_URL;
  delete drillEnv.DATABASE_URL;
  runNpmScript('drill:backup-restore', drillEnv);

  const packageEnv = { ...process.env };
  delete packageEnv.CSM_DATABASE_URL;
  delete packageEnv.DATABASE_URL;
  delete packageEnv.CSM_BACKUP_DRILL_DATABASE_URL;
  runNpmScript('verify:package', packageEnv);
  runNpmScript('verify:supply-chain', packageEnv);
} catch (error) {
  operationError = error;
}

const cleanupErrors = [];
if (created) {
  try {
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
      [databaseName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
  } catch (error) {
    cleanupErrors.push(error);
  }
}
try { await admin.end(); } catch (error) { cleanupErrors.push(error); }

if (operationError || cleanupErrors.length > 0) {
  const errors = [operationError, ...cleanupErrors].filter(Boolean);
  throw new AggregateError(errors, 'Commercial release verification failed');
}

process.stdout.write(`Commercial release verification passed; isolated database ${databaseName} removed\n`);

function requireReleaseDatabaseUrl() {
  const value = process.env.CSM_RELEASE_DATABASE_URL;
  if (!value) {
    throw new Error(
      'CSM_RELEASE_DATABASE_URL is required; it supplies server credentials for an isolated disposable test database',
    );
  }
  const url = new URL(value);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('CSM_RELEASE_DATABASE_URL must use the postgres or postgresql scheme');
  }
  return value;
}

function runNpmScript(script, env) {
  const windows = process.platform === 'win32';
  const command = windows ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
  const args = windows
    ? ['/d', '/s', '/c', `npm.cmd run ${script}`]
    : ['run', script];
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
    timeout: 900_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm run ${script} failed with exit code ${result.status}`);
}

function databaseUrl(base, name) {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  assertBackupDrillThresholds,
  buildBackupDrillReport,
  readBackupDrillConfig,
} from './backup-drill-config.js';
import { assertSnapshots, readRestored, seedSource, type Snapshot } from './backup-drill-data.js';
import {
  decodeDatabasePassword,
  readServerMajor,
  resolvePgClientTools,
  runPgTool,
  sanitizedDatabaseUrl,
} from './pg-client-tools.js';

const baseUrl = requireDatabaseUrl();
const drillConfig = readBackupDrillConfig();
const suffix = `${Date.now()}_${process.pid}`;
const sourceName = `csm_backup_source_${suffix}`;
const restoreName = `csm_backup_restore_${suffix}`;
const dumpPath = join('.tmp', `csm-backup-drill-${suffix}.dump`);

async function main(): Promise<void> {
  const totalStartedAt = performance.now();
  mkdirSync('.tmp', { recursive: true });
  const admin = new Pool({ connectionString: databaseUrl('postgres') });
  let source: Snapshot | undefined;
  let restored: Snapshot | undefined;
  let backupMs = 0;
  let restoreAndValidateMs = 0;
  let operationError: unknown;
  try {
    const tools = await resolvePgClientTools(await readServerMajor(admin));
    await createDatabase(admin, sourceName);
    source = await seedSource(databaseUrl(sourceName), drillConfig.memoryCount);
    const backupStartedAt = performance.now();
    await runPgTool(tools.dump, dumpArguments(sourceName), databasePassword());
    backupMs = durationMs(backupStartedAt);
    const restoreStartedAt = performance.now();
    await createDatabase(admin, restoreName);
    await runPgTool(tools.restore, restoreArguments(restoreName), databasePassword());
    restored = await readRestored(databaseUrl(restoreName));
    restoreAndValidateMs = durationMs(restoreStartedAt);
    assertSnapshots(source, restored);
  } catch (error) {
    operationError = error;
  }
  const errors = await cleanupResources(admin);
  if (operationError !== undefined) errors.unshift(operationError);
  if (errors.length > 0) throw new AggregateError(errors, 'Backup/restore drill failed');
  if (!source || !restored) throw new Error('Backup/restore drill produced no verified snapshots');
  const report = buildBackupDrillReport(source, restored, {
    backupMs,
    restoreAndValidateMs,
    totalMs: durationMs(totalStartedAt),
  });
  assertBackupDrillThresholds(report, drillConfig);
  process.stdout.write(
    `Backup/restore drill passed: ${source.sessions} sessions, ${source.memories} memories, ${source.migrations} migrations; RPO loss ${report.rpo.recordsLost}; RTO ${report.timings.restoreAndValidateMs}ms; cleanup verified\n`,
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

function dumpArguments(databaseName: string): string[] {
  return connectionArguments(databaseName).concat([
    '--format=custom', '--no-owner', '--no-acl', '--file', dumpPath,
  ]);
}

function restoreArguments(databaseName: string): string[] {
  return connectionArguments(databaseName).concat([
    '--no-owner', '--no-acl', '--exit-on-error', dumpPath,
  ]);
}

function connectionArguments(databaseName: string): string[] {
  return ['--dbname', sanitizedDatabaseUrl(baseUrl, databaseName)];
}

async function createDatabase(admin: Pool, name: string): Promise<void> {
  await admin.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
}

async function dropDatabase(admin: Pool, name: string): Promise<void> {
  await admin.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
    [name],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
}

async function cleanupResources(admin: Pool): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const name of [restoreName, sourceName]) {
    try { await dropDatabase(admin, name); } catch (error) { errors.push(error); }
  }
  try { await verifyDatabasesRemoved(admin); } catch (error) { errors.push(error); }
  try { await admin.end(); } catch (error) { errors.push(error); }
  try { rmSync(dumpPath, { force: true }); } catch (error) { errors.push(error); }
  return errors;
}

async function verifyDatabasesRemoved(admin: Pool): Promise<void> {
  const result = await admin.query<{ datname: string }>(
    'SELECT datname FROM pg_database WHERE datname = ANY($1::text[])',
    [[sourceName, restoreName]],
  );
  if (result.rows.length > 0) {
    throw new Error(`Backup drill databases remain: ${result.rows.map((row) => row.datname).join(', ')}`);
  }
}

function databaseUrl(name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function durationMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function databasePassword(): string {
  return decodeDatabasePassword(baseUrl);
}

function requireDatabaseUrl(): string {
  const url = process.env.CSM_DATABASE_URL;
  if (!url) throw new Error('CSM_DATABASE_URL is required for the isolated backup/restore drill');
  return url;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

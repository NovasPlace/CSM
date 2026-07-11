import { createHash } from 'node:crypto';
import type { DatabasePool } from '../types.js';

export type MigrationProvider = 'postgres' | 'sqlite';

export interface SchemaMigration {
  id: string;
  contract: string;
  implementation: readonly string[];
  acceptedLegacyChecksums?: readonly string[];
  run: () => Promise<void>;
}

export interface AppliedMigration {
  id: string;
  checksum: string;
  provider: MigrationProvider;
}

interface MigrationRow {
  migration_id?: unknown;
  checksum?: unknown;
  provider?: unknown;
}

export class MigrationHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationHistoryError';
  }
}

export function migrationChecksum(migration: SchemaMigration): string {
  return createHash('sha256')
    .update([
      migration.id,
      migration.contract,
      ...migration.implementation,
    ].join('\n---csm-migration-artifact---\n'), 'utf8')
    .digest('hex');
}

export async function ensureMigrationLedger(
  pool: DatabasePool,
  provider: MigrationProvider,
): Promise<void> {
  const timestampType = provider === 'postgres' ? 'TIMESTAMPTZ' : 'TEXT';
  const timestampDefault = provider === 'postgres' ? 'now()' : "(datetime('now'))";
  await pool.query(`
    CREATE TABLE IF NOT EXISTS csm_schema_migrations (
      migration_id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('postgres', 'sqlite')),
      execution_ms INTEGER NOT NULL CHECK (execution_ms >= 0),
      applied_at ${timestampType} NOT NULL DEFAULT ${timestampDefault}
    )
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_csm_schema_migrations_applied ON csm_schema_migrations(applied_at DESC)',
  );
}

export async function readMigrationHistory(pool: DatabasePool): Promise<AppliedMigration[]> {
  const result = await pool.query(
    'SELECT migration_id, checksum, provider FROM csm_schema_migrations ORDER BY migration_id',
  );
  return (result.rows as MigrationRow[]).map(toAppliedMigration);
}

export function validateMigrationHistory(
  migrations: SchemaMigration[],
  applied: AppliedMigration[],
  provider: MigrationProvider,
): void {
  const manifest = buildManifest(migrations);
  for (const entry of applied) validateAppliedMigration(entry, manifest, provider);
}

export async function recordMigration(
  pool: DatabasePool,
  migration: SchemaMigration,
  provider: MigrationProvider,
  executionMs: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO csm_schema_migrations
     (migration_id, checksum, provider, execution_ms)
     VALUES ($1, $2, $3, $4)`,
    [migration.id, migrationChecksum(migration), provider, normalizeExecutionMs(executionMs)],
  );
}

function normalizeExecutionMs(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Migration execution_ms must be a finite non-negative number: ${value}`);
  }
  return Math.round(value);
}

function buildManifest(migrations: SchemaMigration[]): Map<string, SchemaMigration> {
  const manifest = new Map<string, SchemaMigration>();
  for (const migration of migrations) {
    if (manifest.has(migration.id)) {
      throw new MigrationHistoryError(`Duplicate migration id in manifest: ${migration.id}`);
    }
    if (migration.implementation.length === 0) {
      throw new MigrationHistoryError(`Migration has no checksum artifacts: ${migration.id}`);
    }
    manifest.set(migration.id, migration);
  }
  return manifest;
}

function validateAppliedMigration(
  entry: AppliedMigration,
  manifest: Map<string, SchemaMigration>,
  provider: MigrationProvider,
): void {
  const migration = manifest.get(entry.id);
  if (!migration) throw new MigrationHistoryError(`Database has unknown migration: ${entry.id}`);
  if (entry.provider !== provider) {
    throw new MigrationHistoryError(`Migration provider mismatch for ${entry.id}`);
  }
  const accepted = new Set([
    migrationChecksum(migration),
    ...(migration.acceptedLegacyChecksums ?? []),
  ]);
  if (!accepted.has(entry.checksum)) {
    throw new MigrationHistoryError(`Migration checksum mismatch for ${entry.id}`);
  }
}

function toAppliedMigration(row: MigrationRow): AppliedMigration {
  if (typeof row.migration_id !== 'string'
    || typeof row.checksum !== 'string'
    || (row.provider !== 'postgres' && row.provider !== 'sqlite')) {
    throw new MigrationHistoryError('Malformed migration ledger row');
  }
  return { id: row.migration_id, checksum: row.checksum, provider: row.provider };
}

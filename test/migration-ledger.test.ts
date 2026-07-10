import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MigrationHistoryError,
  migrationChecksum,
  recordMigration,
  validateMigrationHistory,
} from '../dist/schema/migration-ledger.js';
import type {
  AppliedMigration,
  SchemaMigration,
} from '../dist/schema/migration-ledger.js';

function migration(id = '20260709-001-example'): SchemaMigration {
  return {
    id,
    contract: 'example-v1:create example table',
    implementation: ['CREATE TABLE example (id BIGINT PRIMARY KEY)'],
    run: async () => {},
  };
}

function applied(
  definition: SchemaMigration,
  provider: 'postgres' | 'sqlite' = 'postgres',
): AppliedMigration {
  return {
    id: definition.id,
    checksum: migrationChecksum(definition),
    provider,
  };
}

describe('migration ledger history validation', () => {
  it('creates a stable SHA-256 checksum from contract and implementation', () => {
    const definition = migration();
    const first = migrationChecksum(definition);
    const second = migrationChecksum(definition);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(first, second);
  });

  it('changes the checksum when executable migration material changes', () => {
    const definition = migration();
    const changed = {
      ...definition,
      implementation: ['CREATE TABLE example (id TEXT PRIMARY KEY)'],
    };
    assert.notEqual(migrationChecksum(definition), migrationChecksum(changed));
    assert.throws(
      () => validateMigrationHistory([changed], [applied(definition)], 'postgres'),
      /Migration checksum mismatch/,
    );
  });

  it('accepts an exact migration history match', () => {
    const definition = migration();
    assert.doesNotThrow(() => {
      validateMigrationHistory([definition], [applied(definition)], 'postgres');
    });
  });

  it('rejects checksum drift in an applied migration', () => {
    const definition = migration();
    const changed = { ...applied(definition), checksum: '0'.repeat(64) };
    assert.throws(
      () => validateMigrationHistory([definition], [changed], 'postgres'),
      /Migration checksum mismatch/,
    );
  });

  it('rejects a database migration unknown to this release', () => {
    const definition = migration();
    const future = applied(migration('20990101-001-future'));
    assert.throws(
      () => validateMigrationHistory([definition], [future], 'postgres'),
      /Database has unknown migration/,
    );
  });

  it('rejects provider history copied to a different backend', () => {
    const definition = migration();
    assert.throws(
      () => validateMigrationHistory([definition], [applied(definition, 'sqlite')], 'postgres'),
      /Migration provider mismatch/,
    );
  });

  it('rejects duplicate manifest identifiers', () => {
    const definition = migration();
    assert.throws(
      () => validateMigrationHistory([definition, definition], [], 'postgres'),
      MigrationHistoryError,
    );
  });

  it('normalizes fractional execution time for the integer ledger column', async () => {
    const calls: unknown[][] = [];
    const pool = {
      async query(_sql: string, params?: unknown[]) {
        calls.push(params ?? []);
        return { rows: [], rowCount: 1 };
      },
    } as any;
    await recordMigration(pool, migration(), 'postgres', 63.503);
    assert.equal(calls[0][3], 64);
  });
});

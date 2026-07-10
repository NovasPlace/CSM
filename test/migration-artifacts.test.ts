import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MIGRATION_ARTIFACTS } from '../dist/schema/migration-artifacts.js';
import { migrationChecksum } from '../dist/schema/migration-ledger.js';
import { buildPostgresMigrations as buildDist } from '../dist/schema/postgres-migrations.js';
import { buildPostgresMigrations as buildSource } from '../src/schema/postgres-migrations.ts';

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fakeDatabase() {
  const pool = {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release() {} }),
    end: async () => {},
    getDialect: () => 'pg' as const,
  };
  return { database: { dialect: 'pg', getPool: () => pool }, pool };
}

describe('immutable migration artifacts', () => {
  it('matches every committed source artifact hash', () => {
    for (const artifacts of Object.values(MIGRATION_ARTIFACTS)) {
      for (const artifact of artifacts) {
        assert.equal(sha256(artifact.path), artifact.sha256, artifact.path);
      }
    }
  });

  it('produces identical checksums from source and dist entrypoints', () => {
    const { database, pool } = fakeDatabase();
    const source = buildSource(database as never, pool);
    const dist = buildDist(database as never, pool);
    assert.deepEqual(
      source.map((migration) => [migration.id, migrationChecksum(migration)]),
      dist.map((migration) => [migration.id, migrationChecksum(migration)]),
    );
  });
});

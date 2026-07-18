import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
  artifactsFor,
  legacyArtifactsFor,
  MIGRATION_ARTIFACTS,
} from '../dist/schema/migration-artifacts.js';
import { migrationChecksum } from '../dist/schema/migration-ledger.js';
import { buildPostgresMigrations as buildDist } from '../dist/schema/postgres-migrations.js';
import { hashArtifactContent } from '../dist/schema/artifact-content-hash.js';
import { buildPostgresMigrations as buildSource } from '../src/schema/postgres-migrations.ts';

function sha256(path: string): string {
  return hashArtifactContent(path, readFileSync(path));
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

  it('matches every committed source artifact hash', () => {
    for (const artifacts of Object.values(MIGRATION_ARTIFACTS)) {
      for (const artifact of artifacts) {
        assert.equal(
          sha256(artifact.path),
          artifact.sourceSha256 ?? artifact.sha256,
          artifact.path,
        );
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

  it('accepts the faulty migration 026 checksum so migration 027 can repair it', () => {
    const { database, pool } = fakeDatabase();
    const migration = buildSource(database as never, pool)
      .find((entry) => entry.id === '20260718-026-postgres-embedding-dimension');
    assert.ok(migration);
    assert.ok(migration.acceptedLegacyChecksums?.includes(
      '0a8c85e1bb86e13822afe7c1b906834ca28807f1c0732b422821071d71cf17b5',
    ));
  });

  it('matches the committed checksum for equivalent LF and CRLF text', () => {
    const artifact = MIGRATION_ARTIFACTS['20260709-003-memory'][0];
    const canonicalLf = readFileSync(artifact.path).toString('utf8').replace(/\r\n/g, '\n');
    const lf = Buffer.from(canonicalLf, 'utf8');
    const crlf = Buffer.from(canonicalLf.replace(/\n/g, '\r\n'), 'utf8');
    const currentHash = artifact.sourceSha256 ?? artifact.sha256;
    assert.equal(hashArtifactContent(artifact.path, lf), currentHash);
    assert.equal(hashArtifactContent(artifact.path, crlf), currentHash);
  });

  it('canonicalizes recognized extensionless text dotfiles', () => {
    const lf = Buffer.from('CSM_MODE=development\n');
    const crlf = Buffer.from('CSM_MODE=development\r\n');
    assert.equal(hashArtifactContent('.env', lf), hashArtifactContent('.env', crlf));
  });

  it('detects a substantive text change after canonicalization', () => {
    const path = 'fixture.ts';
    const original = Buffer.from('export const value = 1;\n');
    const changed = Buffer.from('export const value = 2;\n');
    assert.notEqual(hashArtifactContent(path, original), hashArtifactContent(path, changed));
  });

  it('hashes binary artifacts byte-for-byte', () => {
    const bytes = Buffer.from([0x00, 0x0d, 0x0a, 0xff]);
    const expected = createHash('sha256').update(bytes).digest('hex');
    assert.equal(hashArtifactContent('fixture.bin', bytes), expected);
    assert.notEqual(
      hashArtifactContent('fixture.bin', bytes),
      hashArtifactContent('fixture.bin', Buffer.from([0x00, 0x0a, 0xff])),
    );
  });

  it('rejects mixed and bare-CR text line endings', () => {
    assert.throws(
      () => hashArtifactContent('fixture.ts', Buffer.from('one\r\ntwo\n')),
      /mixed LF and CRLF/,
    );
    assert.throws(
      () => hashArtifactContent('fixture.ts', Buffer.from('one\rtwo')),
      /bare CR/,
    );
  });

  it('records current source pins while accepting the explicit historical artifact set', () => {
    const artifact = MIGRATION_ARTIFACTS['20260709-003-memory']
      .find((entry) => entry.path === 'src/embeddings.ts');
    assert.ok(artifact?.sourceSha256);
    assert.notEqual(artifact.sourceSha256, artifact.sha256);
    const implementation = artifactsFor('20260709-003-memory').join('\n');
    const legacy = legacyArtifactsFor('20260709-003-memory').join('\n');
    assert.match(implementation, new RegExp(artifact.sourceSha256));
    assert.doesNotMatch(implementation, new RegExp(artifact.sha256));
    assert.match(legacy, new RegExp(artifact.sha256));
  });

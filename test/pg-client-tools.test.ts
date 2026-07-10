import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeDatabasePassword,
  parsePgToolMajor,
  runPgTool,
  sanitizedDatabaseUrl,
} from '../scripts/pg-client-tools.ts';

  it('parses supported pg_dump output', () => {
    assert.equal(parsePgToolMajor('pg_dump (PostgreSQL) 16.9'), 16);
  });

  it('parses supported pg_restore output', () => {
    assert.equal(parsePgToolMajor('pg_restore (PostgreSQL) 14.18'), 14);
  });

  it('rejects an unknown version format', () => {
    assert.throws(() => parsePgToolMajor('pg_dump unknown'), /Unable to parse/);
  });

  it('decodes reserved password characters for PGPASSWORD', () => {
    assert.equal(
      decodeDatabasePassword('postgresql://user:p%40ss%3Aword@db.example/csm'),
      'p@ss:word',
    );
  });

  it('removes the password while preserving TLS URL parameters', () => {
    const result = sanitizedDatabaseUrl(
      'postgresql://user:p%40ss@db.example/csm?sslmode=verify-full&sslrootcert=%2Fca.pem',
      'restored',
    );
    assert.ok(!result.includes('p%40ss'));
    assert.ok(result.includes('/restored'));
    assert.ok(result.includes('sslmode=verify-full'));
    assert.ok(result.includes('sslrootcert=%2Fca.pem'));
  });

  it('removes credential query parameters from process-safe URLs', () => {
    const result = sanitizedDatabaseUrl(
      'postgresql://user@db.example/csm?password=secret&sslpassword=tls-secret&passfile=%2Fsecret&sslmode=require',
      'restored',
    );
    assert.ok(!result.includes('secret'));
    assert.ok(!result.includes('password='));
    assert.ok(!result.includes('passfile='));
    assert.ok(result.includes('sslmode=require'));
  });

  it('waits for a timed-out child process to close before rejecting', async () => {
    const previous = process.env.CSM_PG_TOOL_TIMEOUT_MS;
    process.env.CSM_PG_TOOL_TIMEOUT_MS = '1000';
    const startedAt = Date.now();
    try {
      await assert.rejects(
        () => runPgTool(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], ''),
        /timed out after 1000ms/,
      );
      assert.ok(Date.now() - startedAt >= 900);
    } finally {
      if (previous === undefined) delete process.env.CSM_PG_TOOL_TIMEOUT_MS;
      else process.env.CSM_PG_TOOL_TIMEOUT_MS = previous;
    }
  });

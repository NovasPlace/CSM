import { it } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteSqliteSql } from '../dist/db/sqlite-sql-rewriter.js';

it('rewrites placeholders and casts only in executable SQL', () => {
  const result = rewriteSqliteSql(
    `SELECT '$1::int' AS literal, "$2::text" AS identifier, $2::text
     -- $3::bigint
     WHERE id = $1::bigint`,
    [7, 'value'],
  );
  assert.match(result.sql, /'\$1::int'/);
  assert.match(result.sql, /"\$2::text"/);
  assert.match(result.sql, /-- \$3::bigint/);
  assert.deepEqual(result.params, ['value', 7]);
});

it('preserves nested block-comment and dollar-quoted content', () => {
  const result = rewriteSqliteSql(
    'SELECT /* outer $2::text /* nested $3 */ end */ $1, $$ $4::int $$',
    ['safe'],
  );
  assert.match(result.sql, /outer \$2::text/);
  assert.match(result.sql, /\$\$ \$4::int \$\$/);
  assert.deepEqual(result.params, ['safe']);
});

it('maps repeated and out-of-order parameters deterministically', () => {
  const result = rewriteSqliteSql('SELECT $2, $1, $2', ['left', 'right']);
  assert.equal(result.sql, 'SELECT ?, ?, ?');
  assert.deepEqual(result.params, ['right', 'left', 'right']);
});

it('rejects missing, zero, and out-of-range parameters before execution', () => {
  assert.throws(() => rewriteSqliteSql('SELECT $1'), /no matching parameter/);
  assert.throws(() => rewriteSqliteSql('SELECT $0', ['x']), /no matching parameter/);
  assert.throws(() => rewriteSqliteSql('SELECT $2', ['x']), /no matching parameter/);
});

it('rejects unterminated protected SQL segments clearly', () => {
  assert.throws(() => rewriteSqliteSql("SELECT 'open"), /unterminated quoted/);
  assert.throws(() => rewriteSqliteSql('SELECT /* open'), /unterminated block comment/);
  assert.throws(() => rewriteSqliteSql('SELECT $tag$ open'), /unterminated dollar-quoted/);
});

it('strips typmod, qualified, quoted, and multi-word casts completely', () => {
  const result = rewriteSqliteSql(
    'SELECT $1::numeric(10,2), $2::pg_catalog.int4[], $3::"custom"."Type"[], $4::timestamp with time zone',
    [1, 2, 3, 4],
  );
  assert.equal(result.sql, 'SELECT ?, ?, ?, ?');
  assert.deepEqual(result.params, [1, 2, 3, 4]);
});

it('preserves PostgreSQL escaped-string contents', () => {
  const result = rewriteSqliteSql("SELECT E'it\\'s $2::int', $1", ['safe']);
  assert.match(result.sql, /E'it\\'s \$2::int'/);
  assert.deepEqual(result.params, ['safe']);
});

it('rejects surplus bind parameters and malformed casts', () => {
  assert.throws(() => rewriteSqliteSql('SELECT $1', ['used', 'surplus']), /not referenced/);
  assert.throws(() => rewriteSqliteSql('SELECT $1::numeric(bad)', [1]), /unsupported PostgreSQL cast/);
});

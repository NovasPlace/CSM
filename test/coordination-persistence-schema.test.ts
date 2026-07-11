import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { CoordinationPersistenceStore } from '../dist/coordination-persistence/store.js';
import { initializeCoordinationPersistenceSchema } from '../dist/coordination-persistence/schema.js';
import { createCoordinationDatabase, destroyCoordinationDatabase, type CoordinationTestDatabase } from './coordination-persistence-fixture.js';

let database: CoordinationTestDatabase;

before(async () => { database = await createCoordinationDatabase('schema'); });
after(async () => { await destroyCoordinationDatabase(database); });

it('creates the complete twelve-table persistence surface', async () => {
  const result = await database.pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
     AND tablename LIKE 'coordination_%' ORDER BY tablename`,
  );
  assert.equal(result.rows.length, 12);
});

it('reruns the additive schema without error or duplicate tables', async () => {
  await initializeCoordinationPersistenceSchema(database.adapter);
  const result = await database.pool.query(`SELECT count(*)::int AS count FROM pg_tables WHERE tablename LIKE 'coordination_%'`);
  assert.equal(result.rows[0].count, 12);
});

it('rejects SQLite before issuing any SQL', () => {
  let calls = 0;
  const pool = { query: async () => { calls += 1; return { rows: [], rowCount: 0 }; },
    connect: async () => { throw new Error('must not connect'); }, end: async () => undefined,
    getDialect: () => 'sqlite' as const };
  assert.throws(() => new CoordinationPersistenceStore(pool), /requires PostgreSQL/);
  assert.equal(calls, 0);
});

it('rejects an unknown provider before issuing any SQL', () => {
  let calls = 0;
  const pool = { query: async () => { calls += 1; return { rows: [], rowCount: 0 }; },
    connect: async () => { throw new Error('must not connect'); }, end: async () => undefined };
  assert.throws(() => new CoordinationPersistenceStore(pool), /requires PostgreSQL/);
  assert.equal(calls, 0);
});

it('installs the deferred primary-role invariant trigger', async () => {
  const result = await database.pool.query(`SELECT tgname FROM pg_trigger WHERE tgname = 'trg_coordination_primary_agent_role'`);
  assert.equal(result.rows.length, 1);
});

it('installs the resource-claim conflict trigger', async () => {
  const result = await database.pool.query(`SELECT tgname FROM pg_trigger WHERE tgname = 'trg_coordination_claim_guard'`);
  assert.equal(result.rows.length, 1);
});

it('installs the append-only event trigger', async () => {
  const result = await database.pool.query(`SELECT tgname FROM pg_trigger WHERE tgname = 'trg_coordination_events_append_only'`);
  assert.equal(result.rows.length, 1);
});

it('installs the workspace event-sequence consistency trigger', async () => {
  const result = await database.pool.query(`SELECT tgname FROM pg_trigger WHERE tgname = 'trg_coordination_event_sequence'`);
  assert.equal(result.rows.length, 1);
});

it('indexes every foreign-key read path', async () => {
  const result = await database.pool.query(`SELECT count(*)::int AS count FROM pg_indexes WHERE indexname LIKE 'idx_coordination_%'`);
  assert.ok(result.rows[0].count >= 13);
});

it('uses JSONB for every structured durable column', async () => {
  const result = await database.pool.query(
    `SELECT data_type FROM information_schema.columns WHERE table_name LIKE 'coordination_%'
     AND column_name IN ('capabilities','allowed_resources','required_deliverables','completion_criteria',
       'evidence','findings','deliverables','changed_resources','unresolved_questions','risks',
       'verification_results','action_preview','payload','result')`,
  );
  assert.ok(result.rows.length >= 14);
  assert.ok(result.rows.every((row) => row.data_type === 'jsonb'));
});

it('defines workspace event sequences as bigint', async () => {
  const result = await database.pool.query(
    `SELECT data_type FROM information_schema.columns
     WHERE table_name = 'coordination_workspaces' AND column_name = 'event_sequence'`,
  );
  assert.equal(result.rows[0].data_type, 'bigint');
});

it('forbids malformed idempotency request hashes', async () => {
  await assert.rejects(database.pool.query(
    `INSERT INTO coordination_idempotency_keys
      (workspace_id,idempotency_key,operation,request_hash,result) VALUES ('missing','k','x','bad','{}')`,
  ));
});

it('keeps Coordination tables out of the legacy SQLite schema sources', async () => {
  const result = await database.pool.query(`SELECT to_regclass('coordination_workspaces')::text AS name`);
  assert.equal(result.rows[0].name, 'coordination_workspaces');
  const source = await import('../dist/schema/sqlite/index.js');
  assert.equal('initializeCoordinationPersistenceSchema' in source, false);
});

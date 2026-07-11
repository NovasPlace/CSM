import type { DatabaseClient } from '../types.js';
import { CoordinationPersistenceError } from './errors.js';
import { jsonParameter } from './json.js';

interface IdempotencyRow {
  operation: string;
  request_hash: string;
  result: unknown;
}

export async function readReplay<T>(
  client: DatabaseClient,
  workspaceId: string,
  key: string,
  operation: string,
  hash: string,
): Promise<T | null> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey(workspaceId, key)]);
  const result = await client.query(
    `SELECT operation, request_hash, result FROM coordination_idempotency_keys
     WHERE workspace_id = $1 AND idempotency_key = $2`,
    [workspaceId, key],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as IdempotencyRow;
  if (row.operation !== operation || row.request_hash !== hash) {
    throw new CoordinationPersistenceError('IDEMPOTENCY_CONFLICT', 'Idempotency key was reused with different input', {
      workspaceId, key, operation,
    });
  }
  return row.result as T;
}

export async function writeReplay(
  client: DatabaseClient,
  workspaceId: string,
  key: string,
  operation: string,
  hash: string,
  result: unknown,
): Promise<void> {
  await client.query(
    `INSERT INTO coordination_idempotency_keys
      (workspace_id, idempotency_key, operation, request_hash, result)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [workspaceId, key, operation, hash, jsonParameter(result, 'idempotency result')],
  );
}

function lockKey(workspaceId: string, key: string): string {
  return `coordination:${workspaceId}:${key}`;
}

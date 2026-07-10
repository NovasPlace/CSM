import { resolve } from 'node:path';
import type { DatabaseClient, DatabasePool } from './types.js';
import type { WorkLedgerCaptureInput } from './work-ledger-types.js';
import {
  acquireWorkLedgerFileLock,
  releaseWorkLedgerFileLock,
} from './work-ledger-store.js';

export interface WorkLedgerCaptureLease {
  client: DatabaseClient;
  projectRoot: string;
  filePaths: string[];
}

export async function acquireCaptureLease(
  pool: DatabasePool,
  projectRoot: string,
  filePaths: string[],
): Promise<WorkLedgerCaptureLease> {
  const client = await pool.connect();
  const ordered = [...new Set(filePaths)].sort();
  const acquired: string[] = [];
  try {
    for (const filePath of ordered) {
      await acquireWorkLedgerFileLock(client, projectRoot, filePath);
      acquired.push(filePath);
    }
    return { client, projectRoot, filePaths: acquired };
  } catch (error) {
    let cleanupError: unknown;
    try { await releaseLocks(client, projectRoot, acquired); } catch (cleanup) { cleanupError = cleanup; }
    client.release(asError(cleanupError));
    if (cleanupError) throw new AggregateError([error, cleanupError], 'Work Ledger lock acquisition cleanup failed');
    throw error;
  }
}

export async function releaseCaptureLease(lease: WorkLedgerCaptureLease): Promise<void> {
  let cleanupError: unknown;
  try {
    await releaseLocks(lease.client, lease.projectRoot, lease.filePaths);
  } catch (error) {
    cleanupError = error;
  } finally {
    lease.client.release(asError(cleanupError));
  }
  if (cleanupError) throw cleanupError;
}

export function workLedgerCaptureKey(input: WorkLedgerCaptureInput): string {
  return JSON.stringify([
    input.runId, input.sessionId ?? null, input.toolCallId ?? null,
    input.toolName, resolve(input.projectRoot),
  ]);
}

async function releaseLocks(
  client: DatabaseClient,
  projectRoot: string,
  filePaths: string[],
): Promise<void> {
  const errors: unknown[] = [];
  for (const filePath of [...filePaths].reverse()) {
    try {
      await releaseWorkLedgerFileLock(client, projectRoot, filePath);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 0) return;
  try { await client.query('SELECT pg_advisory_unlock_all()'); } catch (error) { errors.push(error); }
  throw new AggregateError(errors, 'Work Ledger advisory lock cleanup failed');
}

function asError(value: unknown): Error | undefined {
  if (!value) return undefined;
  return value instanceof Error ? value : new Error(String(value));
}

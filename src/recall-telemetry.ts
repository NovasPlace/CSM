import { createHash } from 'node:crypto';
import type { DatabasePool } from './types.js';

export type RecallTelemetrySource =
  | 'search'
  | 'list'
  | 'context_recall';

export interface RecallTelemetryInput {
  memoryId: number;
  sessionId?: string | null;
  projectId?: string | null;
  query: string;
  source: RecallTelemetrySource;
  rank: number;
  score?: number | null;
}

export async function initializeRecallTelemetrySchema(
  pool: DatabasePool,
): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_recall_events (
      id BIGSERIAL PRIMARY KEY,
      memory_id BIGINT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      session_id TEXT,
      project_id TEXT,
      query_hash TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('search', 'list', 'context_recall')),
      rank INTEGER NOT NULL,
      score REAL,
      recalled_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_memory_recall_events_memory
     ON memory_recall_events(memory_id, recalled_at DESC)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_memory_recall_events_session
     ON memory_recall_events(session_id, recalled_at DESC)`,
  );
}

export function hashRecallQuery(query: string): string {
  const normalized = query.trim().toLowerCase();
  return createHash('sha256').update(normalized).digest('hex');
}

export async function recordRecallBatch(
  pool: DatabasePool,
  inputs: RecallTelemetryInput[],
): Promise<number> {
  let inserted = 0;
  for (const input of inputs) {
    await pool.query(
      `INSERT INTO memory_recall_events
       (memory_id, session_id, project_id, query_hash, source, rank, score)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.memoryId,
        input.sessionId ?? null,
        input.projectId ?? null,
        hashRecallQuery(input.query),
        input.source,
        input.rank,
        input.score ?? null,
      ],
    );
    inserted++;
  }
  return inserted;
}

export async function getRecallCounts(
  pool: DatabasePool,
  memoryIds: number[],
): Promise<Map<number, number>> {
  if (memoryIds.length === 0) return new Map();

  const result = await pool.query(
    `SELECT memory_id, COUNT(*)::int AS recall_count
     FROM memory_recall_events
     WHERE memory_id = ANY($1)
     GROUP BY memory_id`,
    [memoryIds],
  );

  return new Map(
    result.rows.map((row) => {
      const typed = row as { memory_id: number; recall_count: number };
      return [typed.memory_id, typed.recall_count];
    }),
  );
}

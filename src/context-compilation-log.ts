/**
 * Phase 5 Transparency Layer 3: Context Compilation Log Store
 *
 * Stores per-call compilation results; queries for review tool; prunes old details.
 */
import { DatabasePool } from './types.js';
import type { ContextCompilationEntry, CompressedPartDetail, BudgetMode } from './types.js';

interface LogCompilationInput {
  sessionId: string;
  mode: BudgetMode;
  budget: number;
  beforeTokens: number;
  afterTokens: number;
  partsCompressed: number;
  partsPinned: number;
  compressedDetails: CompressedPartDetail[];
  pinnedCategories: Record<string, number>;
}

interface CompilationRow {
  id: number;
  session_id: string;
  created_at: Date;
  mode: string;
  budget: number;
  before_tokens: number;
  after_tokens: number;
  parts_compressed: number;
  parts_pinned: number;
  compressed_details: CompressedPartDetail[] | null;
  pinned_categories: Record<string, number> | null;
}

const INSERT_SQL = `
  INSERT INTO context_compilation_log
    (session_id, mode, budget, before_tokens, after_tokens,
     parts_compressed, parts_pinned, compressed_details, pinned_categories)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  RETURNING id, created_at
`;

export async function logCompilation(
  pool: DatabasePool,
  input: LogCompilationInput,
): Promise<{ id: number; createdAt: Date } | null> {
  const details = input.partsCompressed > 0
    ? JSON.stringify(input.compressedDetails)
    : null;
  const cats = Object.keys(input.pinnedCategories).length > 0
    ? JSON.stringify(input.pinnedCategories)
    : null;
  const res = await pool.query(INSERT_SQL, [
    input.sessionId, input.mode, input.budget,
    input.beforeTokens, input.afterTokens,
    input.partsCompressed, input.partsPinned,
    details, cats,
  ]);
  if (res.rows.length === 0) return null;
  const row = res.rows[0] as CompilationRow;
  return { id: row.id, createdAt: row.created_at };
}

const RECENT_SQL = `
  SELECT id, session_id, created_at, mode, budget, before_tokens, after_tokens,
         parts_compressed, parts_pinned, compressed_details, pinned_categories
  FROM context_compilation_log
  WHERE session_id = $1
  ORDER BY created_at DESC LIMIT 1
`;

export async function getRecentCompilation(
  pool: DatabasePool,
  sessionId: string,
): Promise<ContextCompilationEntry | null> {
  const res = await pool.query(RECENT_SQL, [sessionId]);
  if (res.rows.length === 0) return null;
  return rowToEntry(res.rows[0] as CompilationRow);
}

const HISTORY_SQL = `
  SELECT id, session_id, created_at, mode, budget, before_tokens, after_tokens,
         parts_compressed, parts_pinned, compressed_details, pinned_categories
  FROM context_compilation_log
  WHERE session_id = $1
  ORDER BY created_at DESC LIMIT $2
`;

export async function getCompilationHistory(
  pool: DatabasePool,
  sessionId: string,
  limit: number,
): Promise<ContextCompilationEntry[]> {
  const res = await pool.query(HISTORY_SQL, [sessionId, limit]);
  return res.rows.map(r => rowToEntry(r as CompilationRow));
}

const PRUNE_SQL = `
  UPDATE context_compilation_log
  SET compressed_details = NULL
  WHERE created_at < now() - ($1 || ' days')::interval
    AND compressed_details IS NOT NULL
`;

export async function pruneOldDetails(pool: DatabasePool, days: number): Promise<number> {
  const res = await pool.query(PRUNE_SQL, [String(days)]);
  return res.rowCount ?? 0;
}

function rowToEntry(row: CompilationRow): ContextCompilationEntry {
  return {
    id: row.id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    mode: row.mode as BudgetMode,
    budget: row.budget,
    beforeTokens: row.before_tokens,
    afterTokens: row.after_tokens,
    partsCompressed: row.parts_compressed,
    partsPinned: row.parts_pinned,
    compressedDetails: row.compressed_details ?? null,
    pinnedCategories: row.pinned_categories ?? null,
  };
}

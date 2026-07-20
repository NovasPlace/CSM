/**
 * Phase 6: Context Cache Store
 *
 * Stores full prior context items (turns, tool outputs, file reads, errors,
 * decisions) in the DB so they can be replaced in the prompt with compact
 * manifest entries and retrieved on demand via context_fetch / context_search.
 */
import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { DatabasePool } from './types.js';
import { Redactor, redactJsonValue } from './redactor.js';
import { ilikeExpr, dialectFromPool, jsonExtractText, colInParamArray, jsonParam } from './db/query-dialect.js';

export type CacheKind = 'turn' | 'tool_output' | 'file_read' | 'error' | 'decision';

export interface CacheItemInput {
  sessionId: string;
  displayId: string;
  kind: CacheKind;
  createdAt: number;
  messageIndex?: number;
  summary: string;
  content: string;
  metadata?: Record<string, unknown>;
  tokens?: number;
}

export interface CacheItem extends CacheItemInput {
  id: number;
  fetchCount: number;
}

const SECURE_DEFAULT_REDACTOR = new Redactor();
const FILE_PATH_LOOKUP_KEY = '_csmFilePathLookupV1';

function filePathLookup(sessionId: string, filePath: string): string {
  const windowsSyntax = /^[A-Za-z]:[\\/]/.test(filePath)
    || /^\\\\/.test(filePath)
    || (!filePath.startsWith('/') && filePath.includes('\\'));
  const pathApi = windowsSyntax ? win32 : posix;
  const canonical = pathApi.normalize(filePath);
  const comparable = pathApi === win32 ? canonical.toLowerCase() : canonical;
  return createHash('sha256').update(sessionId).update('\0').update(comparable).digest('hex');
}

export async function storeItem(
  pool: DatabasePool, item: CacheItemInput, redactor?: Redactor,
): Promise<void> {
  // Phase 18 — Redact before persistence
  const activeRedactor = redactor ?? SECURE_DEFAULT_REDACTOR;
  const rawMetadata = { ...(item.metadata ?? {}) };
  const sourceFilePath = typeof rawMetadata.filePath === 'string' ? rawMetadata.filePath : undefined;
  const summary = sourceFilePath && item.summary.trim() === sourceFilePath
    ? activeRedactor.redactPath(item.summary).text
    : activeRedactor.redact(item.summary).text;
  const content = activeRedactor.redact(item.content).text;
  if (sourceFilePath) {
    rawMetadata[FILE_PATH_LOOKUP_KEY] = filePathLookup(item.sessionId, sourceFilePath);
    rawMetadata.filePath = activeRedactor.redactPath(sourceFilePath).text;
  }
  const metadata = redactJsonValue(activeRedactor, rawMetadata);
  await pool.query(
    `INSERT INTO context_cache
       (session_id, display_id, kind, created_at, message_index, summary, content, metadata, tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     ON CONFLICT (session_id, display_id) DO NOTHING`,
    [
      item.sessionId, item.displayId, item.kind, item.createdAt,
      item.messageIndex ?? null, summary, content,
      JSON.stringify(metadata), item.tokens ?? null,
    ],
  );
}

export async function fetchItem(
  pool: DatabasePool, sessionId: string, displayId: string,
): Promise<CacheItem | null> {
  await pool.query(
    `UPDATE context_cache SET fetch_count = fetch_count + 1
     WHERE session_id = $1 AND display_id = $2`,
    [sessionId, displayId],
  );
  const res = await pool.query(
    `SELECT * FROM context_cache WHERE session_id = $1 AND display_id = $2`,
    [sessionId, displayId],
  );
  if (res.rows.length === 0) return null;
  return rowToItem(res.rows[0] as Record<string, unknown>);
}

export async function searchItems(
  pool: DatabasePool, sessionId: string, query: string, limit: number,
): Promise<CacheItem[]> {
  const d = dialectFromPool(pool);
  const pattern = `%${query.replace(/[%_]/g, '\\$&')}%`;
  const res = await pool.query(
    `SELECT * FROM context_cache
     WHERE session_id = $1 AND (${ilikeExpr(d, 'summary', 2)} OR ${ilikeExpr(d, 'content', 2)})
     ORDER BY created_at DESC LIMIT $3`,
    [sessionId, pattern, limit],
  );
  return res.rows.map((r) => rowToItem(r as Record<string, unknown>));
}

export async function fetchFileReads(
  pool: DatabasePool, sessionId: string, filePath: string, _redactor?: Redactor,
): Promise<CacheItem[]> {
  const d = dialectFromPool(pool);
  const pathExpression = jsonExtractText(d, 'metadata', 'filePath');
  const lookupExpression = jsonExtractText(d, 'metadata', FILE_PATH_LOOKUP_KEY);
  const params: unknown[] = [sessionId, filePath, filePathLookup(sessionId, filePath)];
  const res = await pool.query(
    `SELECT * FROM context_cache
     WHERE session_id = $1 AND kind = 'file_read'
       AND (${pathExpression} = $2 OR ${lookupExpression} = $3)
     ORDER BY created_at DESC LIMIT 5`,
    params,
  );
  return res.rows.map((r) => rowToItem(r as Record<string, unknown>));
}

export async function fetchLastError(
  pool: DatabasePool, sessionId: string,
): Promise<CacheItem | null> {
  const res = await pool.query(
    `SELECT * FROM context_cache
     WHERE session_id = $1 AND kind = 'error'
     ORDER BY created_at DESC LIMIT 1`,
    [sessionId],
  );
  if (res.rows.length === 0) return null;
  return rowToItem(res.rows[0] as Record<string, unknown>);
}

export async function fetchDecisions(
  pool: DatabasePool, sessionId: string, limit: number,
): Promise<CacheItem[]> {
  const res = await pool.query(
    `SELECT * FROM context_cache
     WHERE session_id = $1 AND kind = 'decision'
     ORDER BY created_at DESC LIMIT $2`,
    [sessionId, limit],
  );
  return res.rows.map((r) => rowToItem(r as Record<string, unknown>));
}

export async function fetchLatestDecisionBySource(
  pool: DatabasePool, sessionId: string, source: string,
): Promise<CacheItem | null> {
  const d = dialectFromPool(pool);
  const res = await pool.query(
    `SELECT * FROM context_cache
     WHERE session_id = $1 AND kind = 'decision' AND ${jsonExtractText(d, 'metadata', 'source')} = $2
     ORDER BY created_at DESC LIMIT 1`,
    [sessionId, source],
  );
  if (res.rows.length === 0) return null;
  return rowToItem(res.rows[0] as Record<string, unknown>);
}

export async function searchLatestDecisionBySources(
  pool: DatabasePool, sessionId: string, query: string, sources: string[],
): Promise<CacheItem | null> {
  const d = dialectFromPool(pool);
  const words = query.replace(/[%_]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) return null;
  const params: unknown[] = [sessionId, jsonParam(d, sources)];
  const conditions = words.map((w) => {
    const idx = params.length + 1;
    params.push(`%${w}%`);
    return `(${ilikeExpr(d, 'summary', idx)} OR ${ilikeExpr(d, 'content', idx)} OR ${ilikeExpr(d, jsonExtractText(d, 'metadata', 'task'), idx)})`;
  });
  const res = await pool.query(
    `SELECT * FROM context_cache
     WHERE session_id = $1 AND kind = 'decision' AND ${colInParamArray(d, jsonExtractText(d, 'metadata', 'source'), 2)}
       AND (${conditions.join(' OR ')})
     ORDER BY created_at DESC LIMIT 1`,
    params,
  );
  if (res.rows.length === 0) return null;
  return rowToItem(res.rows[0] as Record<string, unknown>);
}

export async function countItems(pool: DatabasePool, sessionId: string): Promise<number> {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM context_cache WHERE session_id = $1`,
    [sessionId],
  );
  return (res.rows[0] as Record<string, unknown>).cnt as number;
}

export async function pruneOldItems(
  pool: DatabasePool, sessionId: string, maxItems: number,
): Promise<number> {
  const res = await pool.query(
    `DELETE FROM context_cache WHERE id IN (
       SELECT id FROM context_cache
       WHERE session_id = $1
       ORDER BY created_at ASC
       LIMIT GREATEST(0, (SELECT COUNT(*) FROM context_cache WHERE session_id = $1) - $2)
     )`,
    [sessionId, maxItems],
  );
  return res.rowCount ?? 0;
}

function rowToItem(row: Record<string, unknown>): CacheItem {
  const storedMetadata = typeof row.metadata === 'string'
    ? JSON.parse(row.metadata) as Record<string, unknown>
    : { ...((row.metadata as Record<string, unknown> | undefined) ?? {}) };
  delete storedMetadata[FILE_PATH_LOOKUP_KEY];
  return {
    id: row.id as number,
    sessionId: row.session_id as string,
    displayId: row.display_id as string,
    kind: row.kind as CacheKind,
    createdAt: row.created_at as number,
    messageIndex: row.message_index as number | undefined,
    summary: row.summary as string,
    content: row.content as string,
    metadata: storedMetadata,
    tokens: row.tokens as number | undefined,
    fetchCount: row.fetch_count as number,
  };
}

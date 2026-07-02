export type QueryDialect = 'pg' | 'sqlite';

export function dialectFromProvider(provider: string): QueryDialect {
  return provider === 'sqlite' ? 'sqlite' : 'pg';
}

/** Resolves the dialect from a pool, defaulting to 'pg' when getDialect is absent (e.g. raw pg.Pool). */
export function dialectFromPool(pool: { getDialect?: () => QueryDialect }): QueryDialect {
  return pool.getDialect?.() ?? 'pg';
}

export function nowFn(d: QueryDialect): string {
  return d === 'sqlite' ? "datetime('now')" : 'now()';
}

export function ilikeExpr(d: QueryDialect, col: string, paramIndex: number): string {
  if (d === 'sqlite') {
    return `LOWER(${col}) LIKE LOWER($${paramIndex})`;
  }
  return `${col} ILIKE $${paramIndex}`;
}

export function ilikeLiteralExpr(d: QueryDialect, col: string, literal: string): string {
  if (d === 'sqlite') {
    return `LOWER(${col}) LIKE LOWER('${literal}')`;
  }
  return `${col} ILIKE '${literal}'`;
}

export function jsonKeyExists(d: QueryDialect, col: string, key: string): string {
  if (d === 'sqlite') {
    return `json_type(${col}, '$.${key}') IS NOT NULL`;
  }
  return `${col} ? '${key}'`;
}

export function jsonExtractText(d: QueryDialect, col: string, key: string): string {
  if (d === 'sqlite') {
    return `json_extract(${col}, '$.${key}')`;
  }
  return `${col}->>'${key}'`;
}

export function jsonArrayContains(d: QueryDialect, col: string, paramIndex: number): string {
  if (d === 'sqlite') {
    return `EXISTS (SELECT 1 FROM json_each(${col}) WHERE json_each.value IN (SELECT value FROM json_each($${paramIndex})))`;
  }
  return `${col} && $${paramIndex}`;
}

export function jsonContainsPath(d: QueryDialect, col: string, path: string, paramIndex: number): string {
  if (d === 'sqlite') {
    return `EXISTS (SELECT 1 FROM json_each(json_extract(${col}, '$.${path}')) WHERE json_each.value IN (SELECT value FROM json_each($${paramIndex})))`;
  }
  return `${col}->'${path}' @> $${paramIndex}`;
}

/** value-form JSON extract: PG col->'key', SQLite json_extract(col, '$.key') */
export function jsonExtractValue(d: QueryDialect, col: string, key: string): string {
  if (d === 'sqlite') {
    return `json_extract(${col}, '$.${key}')`;
  }
  return `${col}->'${key}'`;
}

/** JSON containment: PG col @> $N::jsonb, SQLite json_each membership */
export function jsonContainsParam(d: QueryDialect, col: string, paramIndex: number): string {
  if (d === 'sqlite') {
    return `EXISTS (SELECT 1 FROM json_each(${col}) WHERE json_each.value IN (SELECT value FROM json_each($${paramIndex})))`;
  }
  return `${col} @> $${paramIndex}::jsonb`;
}

export function isUniqueViolation(d: QueryDialect, error: unknown): boolean {
  if (d === 'sqlite') {
    const e = error as { code?: string; message?: string };
    return e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.code === 'SQLITE_CONSTRAINT';
  }
  return (error as { code?: string }).code === '23505';
}

export function jsonParam(d: QueryDialect, value: unknown): unknown {
  if (d === 'sqlite') {
    if (Array.isArray(value)) return JSON.stringify(value);
    if (value != null && typeof value === 'object') return JSON.stringify(value);
  }
  return value;
}

export function toDate(d: QueryDialect, value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string') return new Date(value);
  return new Date();
}

export function parseArrayField(d: QueryDialect, value: unknown): unknown[] {
  if (d === 'sqlite' && typeof value === 'string') {
    try { return JSON.parse(value); } catch { return []; }
  }
  return value as unknown[] ?? [];
}

export function parseJsonField(d: QueryDialect, value: unknown): Record<string, unknown> {
  if (d === 'sqlite' && typeof value === 'string') {
    try { return JSON.parse(value); } catch { return {}; }
  }
  return (value as Record<string, unknown>) ?? {};
}

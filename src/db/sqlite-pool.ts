import Database from 'better-sqlite3';
import type { DatabasePool, DatabaseClient } from '../types.js';

const CAST_REGEX = /::\w+(?:\[\])?/g;
const PARAM_REGEX = /\$(\d+)/g;

export function createSqlitePool(filepath: string): Promise<DatabasePool> {
  const db = new Database(filepath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const execQuery = (text: string, params?: unknown[]): { rows: unknown[]; rowCount: number | null } => {
    const cleaned = stripCasts(text);
    const { sql: translated, params: mappedParams } = translateParams(cleaned, params);
    const stmt = db.prepare(translated);
    const isReturning = /^\s*(SELECT|WITH)\b/i.test(translated) || /\bRETURNING\b/i.test(translated);

    if (isReturning) {
      const rows = mappedParams.length > 0 ? stmt.all(...mappedParams) : stmt.all();
      return { rows: rows as unknown[], rowCount: rows.length };
    }

    const info = mappedParams.length > 0 ? stmt.run(...mappedParams) : stmt.run();
    return { rows: [], rowCount: info.changes };
  };

  const makeClient = (): DatabaseClient => ({
    query: (text: string, params?: unknown[]) => Promise.resolve(execQuery(text, params)),
    release: () => {},
  });

  const wrapped: DatabasePool = {
    query: (text: string, params?: unknown[]) => Promise.resolve(execQuery(text, params)),
    connect: () => Promise.resolve(makeClient()),
    end: () => {
      db.close();
      return Promise.resolve();
    },
  };

  return Promise.resolve(wrapped);
}

function stripCasts(sql: string): string {
  return sql.replace(CAST_REGEX, '');
}

function translateParams(sql: string, params?: unknown[]): { sql: string; params: unknown[] } {
  if (!params || params.length === 0) {
    return { sql: sql.replace(PARAM_REGEX, '?'), params: [] };
  }

  const mapped: unknown[] = [];
  const replaced = sql.replace(PARAM_REGEX, (_, numStr: string) => {
    const idx = parseInt(numStr, 10) - 1;
    mapped.push(params[idx]);
    return '?';
  });

  return { sql: replaced, params: mapped };
}

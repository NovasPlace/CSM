import Database from 'better-sqlite3';
import type { DatabasePool, DatabaseClient } from '../types.js';
import { rewriteSqliteSql } from './sqlite-sql-rewriter.js';

export function createSqlitePool(filepath: string): Promise<DatabasePool> {
  const db = new Database(filepath);
  let closed = false;
  initializeSqliteConnection(db);
  const execQuery = (text: string, params?: unknown[]): { rows: unknown[]; rowCount: number | null } => {
    if (closed) throw new Error('SQLite pool is closed');
    const { sql: translated, params: mappedParams } = rewriteSqliteSql(text, params);
    const stmt = db.prepare(translated);
    if (stmt.reader) {
      const rows = mappedParams.length > 0 ? stmt.all(...mappedParams) : stmt.all();
      return { rows: rows as unknown[], rowCount: rows.length };
    }
    const info = mappedParams.length > 0 ? stmt.run(...mappedParams) : stmt.run();
    return { rows: [], rowCount: info.changes };
  };
  const makeClient = (): DatabaseClient => ({
    query: async (text: string, params?: unknown[]) => execQuery(text, params),
    release: () => {},
  });
  const wrapped: DatabasePool = {
    query: async (text: string, params?: unknown[]) => execQuery(text, params),
    connect: async () => {
      if (closed) throw new Error('SQLite pool is closed');
      return makeClient();
    },
    end: async () => {
      if (closed) return;
      db.close();
      closed = true;
    },
    getDialect() {
      return 'sqlite';
    },
  };
  return Promise.resolve(wrapped);
}

export interface SqlitePragmaConnection {
  pragma(source: string): unknown;
  close(): void;
}

export function initializeSqliteConnection(db: SqlitePragmaConnection): void {
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
  } catch (error) {
    try { db.close(); } catch { /* preserve initialization error */ }
    throw error;
  }
}

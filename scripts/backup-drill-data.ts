import { Database } from '../dist/database.js';
import type { DatabasePool, PluginConfig } from '../dist/types.js';

export interface Snapshot {
  sessions: number;
  memories: number;
  migrations: number;
  sentinel: string;
}

export async function seedSource(url: string, memoryCount: number): Promise<Snapshot> {
  const database = new Database(configFor(url));
  await database.connect();
  try {
    const pool = database.getPool();
    await pool.query(
      'INSERT INTO sessions (id, project_id, title) VALUES ($1, $2, $3)',
      ['backup-sentinel-session', 'backup-drill', 'Backup sentinel'],
    );
    await seedMemories(pool, memoryCount);
    return await readSnapshot(pool);
  } finally {
    await database.close();
  }
}

export async function readRestored(url: string): Promise<Snapshot> {
  const database = new Database(configFor(url));
  await database.connect();
  try {
    return await readSnapshot(database.getPool());
  } finally {
    await database.close();
  }
}

export function assertSnapshots(source: Snapshot, restored: Snapshot): void {
  const sameCounts = source.sessions === restored.sessions
    && source.memories === restored.memories
    && source.migrations === restored.migrations;
  if (!sameCounts || restored.sentinel !== 'backup-restore-sentinel') {
    throw new Error(`Backup/restore mismatch: ${JSON.stringify({ source, restored })}`);
  }
}

async function seedMemories(pool: DatabasePool, memoryCount: number): Promise<void> {
  await pool.query(
    `INSERT INTO memories (session_id, project_id, memory_type, content)
     SELECT $1, $2, 'lesson',
       CASE WHEN item = 1 THEN $3 ELSE $4 || item::text END
     FROM generate_series(1, $5::int) AS item`,
    [
      'backup-sentinel-session',
      'backup-drill',
      'backup-restore-sentinel',
      'backup-drill-memory-',
      memoryCount,
    ],
  );
}

async function readSnapshot(pool: DatabasePool): Promise<Snapshot> {
  const before = pool.getStats?.();
  try {
    const result = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM sessions) AS sessions,
         (SELECT COUNT(*)::int FROM memories) AS memories,
         (SELECT COUNT(*)::int FROM csm_schema_migrations) AS migrations,
         (SELECT content FROM memories WHERE content = $1 LIMIT 1) AS sentinel`,
      ['backup-restore-sentinel'],
    );
    return result.rows[0] as Snapshot;
  } catch (error) {
    const after = pool.getStats?.();
    throw new Error(
      `Snapshot query failed; pool=${JSON.stringify({ before, after })}`,
      { cause: error },
    );
  }
}

function configFor(url: string): PluginConfig {
  return {
    databaseUrl: url,
    databaseProvider: 'postgres',
    sqlitePath: '.data/csm-memory.db',
    embeddingModel: 'nomic-embed-text',
    embeddingApiUrl: 'http://localhost:11434',
  } as PluginConfig;
}

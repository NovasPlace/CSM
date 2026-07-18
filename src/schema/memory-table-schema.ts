import type { DatabasePool } from '../types.js';
const MEMORY_COLUMNS = [
  'project_id TEXT',
  'search_vector TSVECTOR',
  'last_accessed_at TIMESTAMPTZ',
  'access_count INT DEFAULT 0',
  'archived_at TIMESTAMPTZ',
  'archive_reason TEXT',
  'archive_batch_id TEXT',
  'archive_source TEXT',
  'archive_note TEXT',
  'superseded_by BIGINT REFERENCES memories(id)',
  'superseded_at TIMESTAMPTZ',
] as const;

export async function initializeMemoryTable(pool: DatabasePool, dimensions: number): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memories (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      project_id TEXT,
      memory_type TEXT NOT NULL CHECK (memory_type IN (
          'conversation', 'workspace', 'repo', 'preference',
          'lesson', 'episodic', 'procedural', 'concept', 'code', 'config', 'error'
      )),
      content TEXT NOT NULL,
      embedding VECTOR(${dimensions}),
      search_vector TSVECTOR,
      importance FLOAT DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
      emotion TEXT DEFAULT 'neutral' CHECK (emotion IN (
          'neutral', 'frustration', 'frustrated', 'success', 'curiosity', 'concern'
        )),
      confidence FLOAT DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
      source TEXT DEFAULT 'manual',
      tags TEXT[] DEFAULT '{}',
      linked_memory_ids BIGINT[] DEFAULT '{}',
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      accessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      access_count INT DEFAULT 0,
      last_accessed_at TIMESTAMPTZ,
      archived_at TIMESTAMPTZ,
      archive_reason TEXT,
      archive_batch_id TEXT,
      archive_source TEXT,
      archive_note TEXT
    )
  `);
  await updateMemoryConstraints(pool);
}

export async function initializeMemoryColumns(pool: DatabasePool): Promise<void> {
  for (const definition of MEMORY_COLUMNS) {
    await pool.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS ${definition}`);
  }
  await pool.query('CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(superseded_by) WHERE superseded_by IS NOT NULL');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_memories_archive_batch ON memories(archive_batch_id) WHERE archive_batch_id IS NOT NULL');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_memories_archive_reason ON memories(archive_reason) WHERE archive_reason IS NOT NULL');
}

async function updateMemoryConstraints(pool: DatabasePool): Promise<void> {
  await pool.query(`
    ALTER TABLE memories
    DROP CONSTRAINT IF EXISTS memories_memory_type_check,
    ADD CONSTRAINT memories_memory_type_check
    CHECK (memory_type IN (
        'conversation', 'workspace', 'repo', 'preference',
        'lesson', 'episodic', 'procedural', 'concept', 'code', 'config', 'error',
        'self_continuity'
      ))
  `);
  await pool.query(`
    ALTER TABLE memories
    DROP CONSTRAINT IF EXISTS memories_emotion_check,
    ADD CONSTRAINT memories_emotion_check
    CHECK (emotion IN (
        'neutral', 'frustration', 'frustrated', 'success', 'curiosity', 'concern'
      ))
  `);
}

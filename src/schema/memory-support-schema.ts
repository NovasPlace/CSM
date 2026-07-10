import type { DatabasePool } from '../types.js';
import { EMBEDDING_DIMENSIONS } from '../embeddings.js';

const MEMORY_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id)',
  'CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type)',
  'CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC)',
  'CREATE INDEX IF NOT EXISTS idx_memories_accessed ON memories(accessed_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source)',
  'CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories USING GIN(tags)',
  'CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id)',
  'CREATE INDEX IF NOT EXISTS idx_memories_archived ON memories(archived_at)',
  'CREATE INDEX IF NOT EXISTS idx_memories_created_ttl ON memories(created_at)',
] as const;

export async function initializeMemoryChunks(pool: DatabasePool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_chunks (
      id BIGSERIAL PRIMARY KEY,
      memory_id BIGINT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      chunk_index INT NOT NULL,
      content TEXT NOT NULL,
      token_count INT NOT NULL,
      embedding VECTOR(${EMBEDDING_DIMENSIONS}) NOT NULL,
      embedding_model TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (memory_id, chunk_index)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_memory_chunks_embedding_hnsw
    ON memory_chunks USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
  `);
}

export async function initializeMemoryIndexes(pool: DatabasePool): Promise<void> {
  for (const sql of MEMORY_INDEXES) await pool.query(sql);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_transcript_msg
    ON memories (session_id, (metadata->>'messageId'))
    WHERE memory_type = 'conversation' AND metadata ? 'fullTranscript'
  `);
}

export async function initializeMemorySearch(pool: DatabasePool): Promise<void> {
  await pool.query(
    `ALTER TABLE memories ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(content, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(array_to_string(tags, ' '), '')), 'B') ||
      setweight(to_tsvector('english', coalesce(metadata::text, '')), 'C')
    ) STORED`,
  );
  await pool.query('CREATE INDEX IF NOT EXISTS idx_memories_search ON memories USING GIN(search_vector)');
}

export async function initializeMemoryMerges(pool: DatabasePool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_merges (
      id BIGSERIAL PRIMARY KEY,
      canonical_id BIGINT NOT NULL REFERENCES memories(id),
      duplicate_ids JSONB NOT NULL,
      reason TEXT NOT NULL,
      normalized_hash TEXT NOT NULL,
      duplicate_count INT NOT NULL,
      merged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      merged_by TEXT NOT NULL DEFAULT 'merge-tool',
      dry_run BOOLEAN NOT NULL DEFAULT false
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_memory_merges_canonical ON memory_merges(canonical_id)');
}

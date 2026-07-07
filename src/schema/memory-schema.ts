import type { DatabasePool } from '../types.js';
import { EMBEDDING_DIMENSIONS } from '../embeddings.js';
import { getLogger } from '../logger.js';

export async function ensureEmbeddingColumnContract(pool: DatabasePool): Promise<void> {
  const result = await pool.query(
    `SELECT format_type(a.atttypid, a.atttypmod) AS column_type
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'memories'
       AND a.attname = 'embedding'
       AND a.attnum > 0
       AND NOT a.attisdropped`,
  );

  if (result.rows.length === 0) {
    await pool.query(
      `ALTER TABLE memories ADD COLUMN embedding VECTOR(${EMBEDDING_DIMENSIONS})`,
    );
    return;
  }

const row = result.rows[0] as { column_type?: string };
  const expectedType = `vector(${EMBEDDING_DIMENSIONS})`;
  if (row.column_type === expectedType) return;

  const legacyColumn = `embedding_legacy_${Date.now()}`;
  await pool.query(`ALTER TABLE memories RENAME COLUMN embedding TO ${legacyColumn}`);
   await pool.query(
     `ALTER TABLE memories ADD COLUMN embedding VECTOR(${EMBEDDING_DIMENSIONS})`,
   );
    getLogger().warn(`Embedding dimension changed: ${row.column_type ?? '(unknown)'} → ${expectedType}. Old column preserved as ${legacyColumn}. Run csm_memory_backfill_embeddings tool to regenerate embeddings at the new dimension.`);
  }

export async function initializeMemorySchema(pool: DatabasePool): Promise<void> {
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
      embedding VECTOR(${EMBEDDING_DIMENSIONS}),
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

  await ensureEmbeddingColumnContract(pool);
  await pool.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS project_id TEXT`);
  await pool.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS search_vector TSVECTOR`);
  await pool.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS access_count INT DEFAULT 0`);
  await pool.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS archive_reason TEXT`);
  await pool.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS archive_batch_id TEXT`);
  await pool.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS archive_source TEXT`);
  await pool.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS archive_note TEXT`);
  await pool.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS superseded_by BIGINT REFERENCES memories(id)`);
  await pool.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(superseded_by) WHERE superseded_by IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_archive_batch ON memories(archive_batch_id) WHERE archive_batch_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_archive_reason ON memories(archive_reason) WHERE archive_reason IS NOT NULL`);

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
    ON memory_chunks
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_accessed ON memories(accessed_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories USING GIN(tags)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id)`);
   try {
     await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_archived ON memories(archived_at)`);
   } catch (_error) {
     getLogger().warn('Archived-memory index skipped on legacy schema');
   }
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_created_ttl ON memories(created_at)`);

  // Partial unique index to prevent duplicate transcript captures (defense against
  // multiple plugin instances or dual event hooks capturing the same message twice).
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_transcript_msg
    ON memories (session_id, (metadata->>'messageId'))
    WHERE memory_type = 'conversation' AND metadata ? 'fullTranscript'
  `);

  try {
    await pool.query(
      `ALTER TABLE memories ADD COLUMN IF NOT EXISTS search_vector tsvector
      GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(content, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(array_to_string(tags, ' '), '')), 'B') ||
        setweight(to_tsvector('english', coalesce(metadata::text, '')), 'C')
      ) STORED`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memories_search ON memories USING GIN(search_vector)`,
    );
  } catch (_error) {
    console.warn('[Database] FTS column/index skipped (may already exist or unsupported)');
  }

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
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_merges_canonical ON memory_merges(canonical_id)`);
}

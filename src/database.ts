// Database connection and schema for Cross-Session Memory
// PostgreSQL with pgvector for semantic search

import pg from 'pg';
import { DatabasePool, PluginConfig } from './types.js';
import { initializeCheckpointSchema } from './checkpoint-schema.js';
import { initializeContextCompilationSchema } from './context-compilation-schema.js';
import { initializeContextCacheSchema } from './context-cache-schema.js';
import { initializeRolloverSchema } from './context-rollover-schema.js';
import { initializeGoalSchema } from './goal-schema.js';

const { Pool } = pg;

export class Database {
  private pool: DatabasePool | null = null;
  private config: PluginConfig;

  constructor(config: PluginConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      const pool = new Pool({
        connectionString: this.config.databaseUrl,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });

      // Test connection
      await pool.query('SELECT NOW()');
      
      this.pool = pool as unknown as DatabasePool;
      console.log('[Database] Connected to PostgreSQL');
      
      // Initialize schema
      await this.initializeSchema();
    } catch (error) {
      console.error('[Database] Connection failed:', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      console.log('[Database] Disconnected from PostgreSQL');
    }
  }

  private async initializeSchema(): Promise<void> {
    if (!this.pool) throw new Error('Database not connected');

    // Enable pgvector extension
    await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector');

    // Note: sessions table already exists with text ID
    // We'll use it as-is and reference it with text type

    // Create memories table (Cognitive Memory Engine)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS memories (
        id BIGSERIAL PRIMARY KEY,
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        project_id TEXT,
        memory_type TEXT NOT NULL CHECK (memory_type IN (
          'conversation', 'workspace', 'repo', 'preference',
          'lesson', 'episodic', 'procedural'
        )),
        content TEXT NOT NULL,
        importance FLOAT DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
        emotion TEXT DEFAULT 'neutral' CHECK (emotion IN (
          'neutral', 'frustration', 'success', 'curiosity', 'concern'
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
        archived_at TIMESTAMPTZ
      )
    `);

    // Create memory_chunks table (for embeddings)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS memory_chunks (
        id BIGSERIAL PRIMARY KEY,
        memory_id BIGINT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        chunk_index INT NOT NULL,
        content TEXT NOT NULL,
        token_count INT NOT NULL,
        embedding VECTOR(1536) NOT NULL,
        embedding_model TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (memory_id, chunk_index)
      )
    `);

    // Create memory_events table (Real-time Bus)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS memory_events (
        id BIGSERIAL PRIMARY KEY,
        channel TEXT NOT NULL,
        payload JSONB NOT NULL,
        session_id TEXT REFERENCES sessions(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Create session_contexts table (Context Brief Cache)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS session_contexts (
        id BIGSERIAL PRIMARY KEY,
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        project_id TEXT,
        context_brief TEXT NOT NULL,
        episodic_memories JSONB DEFAULT '[]',
        procedural_memories JSONB DEFAULT '[]',
        semantic_memories JSONB DEFAULT '[]',
        built_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '90 seconds')
      )
    `);

    // Create indexes
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memory_chunks_embedding_hnsw
      ON memory_chunks
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
    `);

    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id)
    `);

    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type)
    `);

    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC)
    `);

    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memories_accessed ON memories(accessed_at DESC)
    `);

    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source)
    `);

    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories USING GIN(tags)
    `);

    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id)
    `);

    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memories_archived ON memories(archived_at)
    `);

    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_session_contexts_project ON session_contexts(project_id)
    `);

    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memory_events_channel ON memory_events(channel)
    `);

    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memory_events_created ON memory_events(created_at DESC)
    `);

    // Create memory_candidates table
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS memory_candidates (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        proposed_type TEXT NOT NULL CHECK (proposed_type IN (
          'conversation', 'workspace', 'repo', 'preference', 'lesson', 'episodic', 'procedural'
        )),
        content TEXT NOT NULL,
        importance FLOAT DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
        emotion TEXT DEFAULT 'neutral' CHECK (emotion IN (
          'neutral', 'frustration', 'success', 'curiosity', 'concern'
        )),
        confidence FLOAT DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
        tags TEXT[] DEFAULT '{}',
        metadata JSONB NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'auto-approved', 'archived')),
        source TEXT NOT NULL CHECK (source IN ('extractor', 'manual')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        reviewed_at TIMESTAMPTZ,
        reviewed_by TEXT
      )
    `);

    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memory_candidates_session ON memory_candidates(session_id)
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memory_candidates_project ON memory_candidates(project_id)
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memory_candidates_status ON memory_candidates(status)
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memory_candidates_created ON memory_candidates(created_at DESC)
    `);

    // Create project_scopes table
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS project_scopes (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        directory TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        memory_count INTEGER DEFAULT 0
      )
    `);

    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_project_scopes_directory ON project_scopes(directory)
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_project_scopes_last_active ON project_scopes(last_active_at DESC)
    `);

    // Migration: Add project_id and tracking columns to existing tables
    await this.migrateProjectIsolation();

    // Create distilled_summaries table (Tool Call Distiller)
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS distilled_summaries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        groups JSONB NOT NULL DEFAULT '[]',
        compressed TEXT NOT NULL,
        total_calls_summarized INT NOT NULL DEFAULT 0,
        built_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_distilled_summaries_session ON distilled_summaries(session_id)
    `);

    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_distilled_summaries_built ON distilled_summaries(built_at DESC)
    `);

    // Create compaction_metrics table (Prompt Assembly Proof)
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS compaction_metrics (
        id BIGSERIAL PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        total_tool_parts INT NOT NULL DEFAULT 0,
        compacted_parts INT NOT NULL DEFAULT 0,
        skipped_parts INT NOT NULL DEFAULT 0,
        before_chars INT NOT NULL DEFAULT 0,
        after_chars INT NOT NULL DEFAULT 0,
        before_tokens INT NOT NULL DEFAULT 0,
        after_tokens INT NOT NULL DEFAULT 0,
        tokens_saved INT NOT NULL DEFAULT 0,
        saved_percent INT NOT NULL DEFAULT 0,
        semantic_signal_count_preserved INT NOT NULL DEFAULT 0,
        context_brief_chars INT NOT NULL DEFAULT 0,
        discard_marker_present BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_compaction_metrics_session ON compaction_metrics(session_id)
    `);

    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_compaction_metrics_created ON compaction_metrics(created_at DESC)
    `);

    // Create indexes for TTL cleanup
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memories_created_ttl ON memories(created_at)
    `);

    // Phase 4A — Durable Session Checkpointing schema (additive)
    await initializeCheckpointSchema(this.pool);

    // Phase 5 — Context compilation log schema (additive)
    await initializeContextCompilationSchema(this.pool);

    // Phase 6 — Context cache schema (additive)
    await initializeContextCacheSchema(this.pool);

    // Phase 6 — Context rollover cumulative token tracker (additive)
    await initializeRolloverSchema(this.pool);

    // Goal system schema (additive)
    await initializeGoalSchema(this.pool);

    console.log('[Database] Schema initialized');
  }

  private async migrateProjectIsolation(): Promise<void> {
    if (!this.pool) return;
    // Add project_id to memories table (nullable for backward compatibility)
    await this.pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'memories' AND column_name = 'project_id'
        ) THEN
          ALTER TABLE memories ADD COLUMN project_id TEXT;
        END IF;
      END $$;
    `);

    // Add project_id to session_contexts table
    await this.pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'session_contexts' AND column_name = 'project_id'
        ) THEN
          ALTER TABLE session_contexts ADD COLUMN project_id TEXT;
        END IF;
      END $$;
    `);

    // Add tracking columns to memories
    await this.pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'memories' AND column_name = 'last_accessed_at'
        ) THEN
          ALTER TABLE memories ADD COLUMN last_accessed_at TIMESTAMPTZ;
        END IF;
      END $$;
    `);

    await this.pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'memories' AND column_name = 'access_count'
        ) THEN
          ALTER TABLE memories ADD COLUMN access_count INTEGER DEFAULT 0;
        END IF;
      END $$;
    `);

    await this.pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'memories' AND column_name = 'archived_at'
        ) THEN
          ALTER TABLE memories ADD COLUMN archived_at TIMESTAMPTZ;
        END IF;
      END $$;
    `);

    // Create project_id from sessions
    await this.pool.query(`
      UPDATE memories m
      SET project_id = s.project_id
      FROM sessions s
      WHERE m.project_id IS NULL
        AND m.session_id = s.session_id
        AND s.project_id IS NOT NULL
    `);

    await this.pool.query(`
      UPDATE session_contexts sc
      SET project_id = s.project_id
      FROM sessions s
      WHERE sc.project_id IS NULL
        AND sc.session_id = s.session_id
        AND s.project_id IS NOT NULL
    `);
  }

  getPool(): DatabasePool {
    if (!this.pool) throw new Error('Database not connected');
    return this.pool;
  }
}

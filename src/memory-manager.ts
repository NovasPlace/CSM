// Memory Manager - CRUD operations with dual-write pattern
// Inspired by Agent Atlas memory_bridge.py

import { Database } from './database.js';
import { EmbeddingGenerator } from './embeddings.js';
import { extractConcepts } from './concept-extractor.js';
import { buildLinksForMemory } from './memory-graph.js';
import { hybridSearch } from './hybrid-search.js';
import { pruneMemories } from './prune-scorer.js';
import { Redactor } from './redactor.js';
import { DEFAULT_PRUNE_CONFIG } from './types.js';
import { recordRecallBatch, type RecallTelemetrySource } from './recall-telemetry.js';
import { applyTypeQuota } from './memory-type-quota.js';
import { getLogger } from './logger.js';
import { nowFn, ilikeExpr, jsonKeyExists, jsonExtractText, jsonArrayContains, jsonContainsPath, isUniqueViolation, jsonParam, toDate, parseArrayField, parseJsonField } from './db/query-dialect.js';
import {
  Memory,
  MemoryType,
  MemoryEmotion,
  MemorySource,
  MemorySaveOptions,
  MemorySearchOptions,
  MemoryListOptions,
  Session,
  SortBy,
  PruneConfig,
  PruneReport,
  BackfillEmbeddingsOptions,
  BackfillEmbeddingsResult,
} from './types.js';

export class MemoryManager {
  private database: Database;
  private embeddings: EmbeddingGenerator;
  redactor?: Redactor;

  constructor(database: Database, embeddings: EmbeddingGenerator, redactor?: Redactor) {
    this.database = database;
    this.embeddings = embeddings;
    this.redactor = redactor;
  }

  // ==================== Session Operations ====================

  /**
   * Create a new session
   */
  async createSession(sessionId: string, projectPath: string): Promise<Session> {
    const pool = this.database.getPool();
    
    const now = nowFn(this.database.dialect);
    const result = await pool.query(
      `INSERT INTO sessions (id, directory, title, project_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE
       SET directory = EXCLUDED.directory,
           project_id = EXCLUDED.project_id,
           updated_at = ${now}
       RETURNING *`,
      [sessionId, projectPath, `Session ${new Date().toISOString()}`, projectPath]
    );

    const row = result.rows[0] as Record<string, unknown>;
    
    const createdAt = toDate(this.database.dialect, row.created_at);
    const updatedAt = toDate(this.database.dialect, row.updated_at);
    if (createdAt.getTime() === updatedAt.getTime()) {
      await this.emitEvent('session.created', { sessionId: row.id as string });
    }

    return this.mapSession(row);
  }

  /**
   * Archive a session (mark as ended)
   */
  async archiveSession(sessionId: string, summary?: string): Promise<void> {
    const pool = this.database.getPool();
    
    await pool.query(
      `UPDATE sessions 
       SET updated_at = ${nowFn(this.database.dialect)},
           ended_at = ${nowFn(this.database.dialect)},
           summary = COALESCE($1, summary)
       WHERE id = $2`,
      [summary, sessionId]
    );

    await this.emitEvent('session.archived', { sessionId });
  }

  /**
   * Get session by ID
   */
  async getSession(sessionId: string): Promise<Session | null> {
    const pool = this.database.getPool();
    
    const result = await pool.query(
      'SELECT * FROM sessions WHERE id = $1',
      [sessionId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapSession(result.rows[0] as Record<string, unknown>);
  }

  /**
   * Get recent sessions for a project
   */
  async getRecentProjectSessions(projectPath: string, limit: number = 10): Promise<Session[]> {
    const pool = this.database.getPool();
    const now = nowFn(this.database.dialect);
    
    const result = await pool.query(
      `SELECT * FROM sessions
       WHERE directory = $1 OR project_id = $1
       ORDER BY ${now} DESC
       LIMIT $2`,
      [projectPath, limit]
    );

    return result.rows.map(row => this.mapSession(row as Record<string, unknown>));
  }

  // ==================== Memory Operations ====================

  /**
   * Save a memory with dual-write (structured data + embeddings)
   */
async saveMemory(options: MemorySaveOptions): Promise<Memory> {
      // Apply default provenance metadata so all memories are governance-trackable
      const currentMeta = options.metadata ?? {};
      const hasProvenance = currentMeta.source_kind || currentMeta.evidence_strength;
      if (!hasProvenance) {
        options = {
          ...options,
          metadata: {
            source_kind: options.source === 'auto' ? 'transcript' : 'user_supplied',
            evidence_strength: 'direct_original',
            source_session_id: options.sessionId,
            source_agent_id: 'opencode',
            source_model_id: 'default',
            source_surface: 'opencode',
            ...currentMeta,
          },
        };
      }

      const pool = this.database.getPool();

      // Dedup guard for transcript memories: if this exact message was already
      // captured (e.g. by a second plugin instance or a dual event hook), return
      // the existing memory instead of inserting a duplicate.
      const transcriptMsgId = options.metadata?.messageId;
      const isTranscript = options.type === 'conversation'
        && options.metadata?.fullTranscript === true
        && transcriptMsgId != null
        && options.sessionId != null;
      if (isTranscript) {
        const jsonExists = jsonKeyExists(this.database.dialect, 'metadata', 'fullTranscript');
        const jsonExtract = jsonExtractText(this.database.dialect, 'metadata', 'messageId');
        const existing = await pool.query(
          `SELECT * FROM memories
           WHERE session_id = $1
             AND memory_type = 'conversation'
             AND ${jsonExists}
             AND ${jsonExtract} = $2
           LIMIT 1`,
          [options.sessionId, String(transcriptMsgId)],
        );
        if (existing.rows.length > 0) {
          return this.mapMemory(existing.rows[0] as Record<string, unknown>);
        }
      }

      // Phase 18 — Redact content BEFORE any processing (concepts, embeddings, storage)
      let contentToProcess = options.content;
      if (this.redactor) {
        const redactionResult = this.redactor.redact(options.content);
        contentToProcess = redactionResult.text;
      }

      // Phase 5 — Apply per-type content quota (compress success/episodic, preserve errors/lessons)
      const quotaResult = applyTypeQuota(contentToProcess, options.type, options.emotion);
      contentToProcess = quotaResult.content;
      
      // Get project_id from session if available, or use directly-provided projectId
      let projectId: string | null = options.projectId ?? null;
      if (!projectId && options.sessionId) {
        const sessionResult = await pool.query(
          'SELECT project_id FROM sessions WHERE id = $1',
          [options.sessionId]
        );
        if (sessionResult.rows.length > 0) {
          const row = sessionResult.rows[0] as { project_id: string | null };
          projectId = row.project_id ?? null;
        } else {
          await pool.query(
            `INSERT INTO sessions (id, directory, title, project_id)
             VALUES ($1, $2, $3, $3)
             ON CONFLICT (id) DO NOTHING`,
            [options.sessionId, process.cwd(), 'recovered-session']
          );
          projectId = process.cwd();
        }
      }
      
      // Extract concepts from content
      const extraction = extractConcepts(contentToProcess);
      const extracted = extraction.concepts;
      const mergedMetadata = { ...(options.metadata ?? {}), extracted_concepts: extracted };
      const mergedTags = Array.from(new Set([...(options.tags ?? []), ...extracted.map(c => c.value)]));
  
      // Generate embedding first
      let embedding: number[] | null = null;
      try {
        embedding = await this.embeddings.generate(contentToProcess);
      } catch (error) {
        getLogger().error('Failed to generate embedding', error instanceof Error ? error : undefined);
      }
  
       // Insert memory with embedding
       let result;
       try {
         result = await pool.query(
           `INSERT INTO memories (
             session_id, project_id, memory_type, content, importance, emotion,
             confidence, source, tags, linked_memory_ids, metadata, embedding
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING *`,
           [
             options.sessionId,
             projectId,
             options.type,
             contentToProcess,
             options.importance ?? 0.5,
             options.emotion ?? 'neutral',
             options.confidence ?? 1.0,
             options.source ?? 'manual',
             jsonParam(this.database.dialect, mergedTags),
             jsonParam(this.database.dialect, options.linkedMemoryIds ?? []),
             jsonParam(this.database.dialect, mergedMetadata),
             embedding ? `[${embedding.join(',')}]` : null,
           ]
         );
       } catch (error: unknown) {
        // Backstop: race condition between two plugin instances can trigger a
        // unique violation on idx_memories_transcript_msg. Fetch and return the
        // already-stored memory instead of failing the capture.
        if (isTranscript && isUniqueViolation(this.database.dialect, error)) {
          const jsonExists = jsonKeyExists(this.database.dialect, 'metadata', 'fullTranscript');
          const jsonExtract = jsonExtractText(this.database.dialect, 'metadata', 'messageId');
          const existing = await pool.query(
            `SELECT * FROM memories
             WHERE session_id = $1
               AND memory_type = 'conversation'
               AND ${jsonExists}
               AND ${jsonExtract} = $2
             LIMIT 1`,
            [options.sessionId, String(transcriptMsgId)],
          );
          if (existing.rows.length > 0) {
            return this.mapMemory(existing.rows[0] as Record<string, unknown>);
          }
        }
        throw error;
      }
  
      const memory = this.mapMemory(result.rows[0] as Record<string, unknown>);
  
      // Dual-write: Store embedding in memory_chunks too
      if (embedding) {
        try {
          await pool.query(
            `INSERT INTO memory_chunks (memory_id, chunk_index, content, token_count, embedding, embedding_model)
             VALUES ($1, 0, $2, $3, $4, $5)`,
            [
              memory.id,
              contentToProcess,
              Math.ceil(contentToProcess.length / 4), // Rough token estimate
              `[${embedding.join(',')}]`,
              'hash-fallback', // Will be replaced with actual model name
            ]
          );
        } catch (error) {
          getLogger().error('Failed to store embedding chunk', error instanceof Error ? error : undefined);
        }
      }
  
      // Emit event
      await this.emitEvent('memory.created', { memoryId: memory.id, type: options.type });
  
      // Build graph links for this memory
      try {
        const extracted = extractConcepts(contentToProcess);
        await buildLinksForMemory(this.database, memory.id, extracted.concepts);
      } catch (error) {
        getLogger().error('Failed to build graph links', error instanceof Error ? error : undefined);
      }
  
      return memory;
    }

  /**
   * Get memory by ID
   */
  async getMemory(id: number): Promise<Memory | null> {
    const pool = this.database.getPool();
    
    const result = await pool.query(
      'SELECT * FROM memories WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapMemory(result.rows[0] as Record<string, unknown>);
  }

  /**
   * Update memory access (reinforcement)
   */
  async touchMemory(id: number): Promise<void> {
    const pool = this.database.getPool();
    
    await pool.query(
      `UPDATE memories 
       SET accessed_at = ${nowFn(this.database.dialect)}, access_count = access_count + 1
       WHERE id = $1`,
      [id]
    );
  }

  async backfillMissingEmbeddings(
    options: BackfillEmbeddingsOptions,
  ): Promise<BackfillEmbeddingsResult> {
    const rows = await this.loadBackfillRows(options);
    const counts: BackfillEmbeddingsResult = {
      scanned: rows.length,
      eligible: rows.length,
      updated: 0,
      skipped: 0,
      failed: 0,
    };

    if (options.dryRun) {
      counts.skipped = rows.length;
      return counts;
    }

    for (const row of rows) {
      try {
        const embedding = await this.embeddings.generate(row.content);
        await this.storeEmbedding(row.id, row.content, embedding);
        counts.updated++;
      } catch (error) {
        getLogger().error('Embedding backfill failed', error instanceof Error ? error : undefined);
        counts.failed++;
      }
    }

    return counts;
  }

  /**
   * Delete a memory
   */
  async deleteMemory(id: number): Promise<boolean> {
    const pool = this.database.getPool();
    
    const result = await pool.query(
      'DELETE FROM memories WHERE id = $1 RETURNING id',
      [id]
    );

    if (result.rows.length > 0) {
      await this.emitEvent('memory.deleted', { memoryId: id });
      return true;
    }

    return false;
  }

  /**
   * Search memories using semantic similarity
   */
  async searchMemories(
    options: MemorySearchOptions,
    telemetry?: { sessionId?: string; source?: RecallTelemetrySource },
  ): Promise<{ memory: Memory; score: number }[]> {
    const pool = this.database.getPool();

    // SQLite: skip vector search entirely, go to text fallback
    if (this.database.dialect === 'sqlite') {
      getLogger().debug('SQLite: skipping vector search, using text fallback');
      return this.textSearchFallback(options);
    }

    const queryEmbedding = await this.embeddings.generate(options.query);

    try {
      const results = await hybridSearch(
        this.database,
        options.query,
        queryEmbedding,
        options.limit ?? 10,
        { projectId: options.projectId, type: options.type, tags: options.tags, minImportance: options.minImportance, searchMode: options.searchMode, weights: (options as any).weights },
      );

      const memories: { memory: Memory; score: number }[] = [];
      for (const r of results) {
        const row = await pool.query(
          `SELECT * FROM memories WHERE id = $1`,
          [r.id],
        );
        if (row.rows.length > 0) {
          const memory = this.mapMemory(row.rows[0] as Record<string, unknown>);
          await this.touchMemory(memory.id);
          memories.push({ memory, score: r.score });
        }
      }
      await this.recordRecalls(memories, options.query, options.projectId, telemetry);
      return memories;
    } catch (_err) {
      getLogger().warn('Hybrid search failed, falling back to vector-only');
    }

    // Fallback: vector-only search
    const embeddingString = `[${queryEmbedding.join(',')}]`;
    let sql = `
      SELECT m.*,
        1 - (mc.embedding <=> $1::vector) AS similarity
      FROM memories m
      JOIN memory_chunks mc ON m.id = mc.memory_id
      WHERE 1=1
    `;
    const params: unknown[] = [embeddingString];
    let paramIndex = 2;

    const searchMode = options.searchMode ?? 'project';
    if (searchMode === 'project' && options.projectId) {
      sql += ` AND m.project_id = $${paramIndex}`;
      params.push(options.projectId);
      paramIndex++;
    } else if (searchMode === 'legacy') {
      sql += ` AND (m.project_id = $${paramIndex} OR m.project_id IS NULL)`;
      params.push(options.projectId);
      paramIndex++;
    }
    if (options.type) {
      sql += ` AND m.memory_type = $${paramIndex}`;
      params.push(options.type);
      paramIndex++;
    }
    if (options.minImportance !== undefined) {
      sql += ` AND m.importance >= $${paramIndex}`;
      params.push(options.minImportance);
      paramIndex++;
    }
    if (options.tags && options.tags.length > 0) {
      sql += ` AND m.tags && $${paramIndex}`;
      params.push(options.tags);
      paramIndex++;
    }

    sql += ` ORDER BY similarity DESC LIMIT $${paramIndex}`;
    params.push(options.limit ?? 10);

    try {
      const result = await pool.query(sql, params);
      const memories: { memory: Memory; score: number }[] = [];
      for (const row of result.rows) {
        const memory = this.mapMemory(row as Record<string, unknown>);
        const score = (row as Record<string, unknown>).similarity as number;
        await this.touchMemory(memory.id);
        memories.push({ memory, score });
      }
      await this.recordRecalls(memories, options.query, options.projectId, telemetry);
      return memories;
    } catch (_err) {
      getLogger().warn('Vector search failed, falling back to text search');
      const memories = await this.textSearchFallback(options);
      await this.recordRecalls(memories, options.query, options.projectId, telemetry);
      return memories;
    }
  }

  /**
   * List memories with filters
   */
  async listMemories(
    options: MemoryListOptions = {},
    telemetry?: { sessionId?: string; source?: RecallTelemetrySource },
  ): Promise<Memory[]> {
    const pool = this.database.getPool();
    
    let query = 'SELECT * FROM memories WHERE 1=1';
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.projectId) {
      query += ` AND project_id = $${paramIndex}`;
      params.push(options.projectId);
      paramIndex++;
    } else if (options.searchMode === 'project') {
      // Default to current project if available
      // This would need context awareness - for now skip
    } else if (options.searchMode === 'legacy') {
      query += ` AND project_id IS NULL`;
    }

    if (options.type) {
      query += ` AND memory_type = $${paramIndex}`;
      params.push(options.type);
      paramIndex++;
    }

    if (options.tags && options.tags.length > 0) {
      query += ` AND ${jsonArrayContains(this.database.dialect, 'tags', paramIndex)}`;
      params.push(jsonParam(this.database.dialect, options.tags));
      paramIndex++;
    }

    if (options.sessionId) {
      query += ` AND session_id = $${paramIndex}`;
      params.push(options.sessionId);
      paramIndex++;
    }

    if (options.dateFrom) {
      query += ` AND created_at >= $${paramIndex}`;
      params.push(options.dateFrom);
      paramIndex++;
    }

    if (options.dateTo) {
      query += ` AND created_at <= $${paramIndex}`;
      params.push(options.dateTo);
      paramIndex++;
    }

    if (options.entityType && options.entityValue) {
      query += ` AND ${jsonContainsPath(this.database.dialect, 'metadata', 'extracted_concepts', paramIndex)}`;
      params.push(JSON.stringify([{ type: options.entityType, value: options.entityValue }]));
      paramIndex++;
    }

    // Sort
    const sortBy: SortBy = options.sortBy ?? 'recent';
    switch (sortBy) {
      case 'important':
        query += ' ORDER BY importance DESC, accessed_at DESC';
        break;
      case 'accessed':
        query += ' ORDER BY accessed_at DESC';
        break;
      case 'recent':
      default:
        query += ' ORDER BY created_at DESC';
        break;
    }

    const limit = options.limit ?? 20;
    query += ` LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await pool.query(query, params);

    const memories = result.rows.map(row => this.mapMemory(row as Record<string, unknown>));
    await this.recordRecalls(
      memories.map((memory) => ({ memory, score: 0 })),
      this.describeListQuery(options),
      options.projectId,
      telemetry,
    );
    return memories;
  }

  private async textSearchFallback(
    options: MemorySearchOptions,
  ): Promise<{ memory: Memory; score: number }[]> {
    const pool = this.database.getPool();
    let sql = `
      SELECT *
      FROM memories
      WHERE ${ilikeExpr(this.database.dialect, 'content', 1)}
    `;
    const params: unknown[] = [`${options.query}%`];
    let paramIndex = 2;
    const searchMode = options.searchMode ?? 'project';

    if (searchMode === 'project' && options.projectId) {
      sql += ` AND project_id = $${paramIndex}`;
      params.push(options.projectId);
      paramIndex++;
    } else if (searchMode === 'legacy') {
      if (options.projectId) {
        sql += ` AND (project_id = $${paramIndex} OR project_id IS NULL)`;
        params.push(options.projectId);
        paramIndex++;
      } else {
        sql += ' AND project_id IS NULL';
      }
    }
    if (options.type) {
      sql += ` AND memory_type = $${paramIndex}`;
      params.push(options.type);
      paramIndex++;
    }
    if (options.minImportance !== undefined) {
      sql += ` AND importance >= $${paramIndex}`;
      params.push(options.minImportance);
      paramIndex++;
    }
    if (options.tags && options.tags.length > 0) {
      sql += ` AND ${jsonArrayContains(this.database.dialect, 'tags', paramIndex)}`;
      params.push(jsonParam(this.database.dialect, options.tags));
      paramIndex++;
    }

    sql += ` ORDER BY importance DESC, created_at DESC LIMIT $${paramIndex}`;
    params.push(options.limit ?? 10);

    const result = await pool.query(sql, params);
    const memories: { memory: Memory; score: number }[] = [];
    for (const row of result.rows) {
      const memory = this.mapMemory(row as Record<string, unknown>);
      await this.touchMemory(memory.id);
      memories.push({ memory, score: memory.importance });
    }
    return memories;
  }

  /**
   * Get memories by session
   */
  async getMemoriesBySession(sessionId: string): Promise<Memory[]> {
    const pool = this.database.getPool();
    
    const result = await pool.query(
      'SELECT * FROM memories WHERE session_id = $1 ORDER BY created_at DESC',
      [sessionId]
    );

    return result.rows.map(row => this.mapMemory(row as Record<string, unknown>));
  }

  /**
   * Get recent memories for a project
   */
  async getRecentProjectMemories(projectId: string, limit: number = 20): Promise<Memory[]> {
    const pool = this.database.getPool();
    const now = nowFn(this.database.dialect);
    
    const result = await pool.query(
      `SELECT * FROM memories
       WHERE project_id = $1
       ORDER BY ${now} DESC
       LIMIT $2`,
      [projectId, limit]
    );

    return result.rows.map(row => this.mapMemory(row as Record<string, unknown>));
  }

  /**
   * Create or update a project scope
   */
  async upsertProjectScope(projectId: string, name: string, directory: string): Promise<void> {
    const pool = this.database.getPool();
    const now = nowFn(this.database.dialect);
    
    await pool.query(
      `INSERT INTO project_scopes (project_id, name, directory, last_active_at)
       VALUES ($1, $2, $3, ${now})
       ON CONFLICT (project_id) DO UPDATE SET
       name = EXCLUDED.name,
       directory = EXCLUDED.directory,
       last_active_at = EXCLUDED.last_active_at`,
      [projectId, name, directory]
    );
  }

  /**
   * Get project scope by ID
   */
  async getProjectScope(projectId: string): Promise<any | null> {
    const pool = this.database.getPool();
    
    const result = await pool.query('SELECT * FROM project_scopes WHERE project_id = $1', [projectId]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return result.rows[0] as Record<string, unknown>;
  }

  /**
   * Update project scope last active time
   */
  async updateProjectScopeLastActive(projectId: string): Promise<void> {
    const pool = this.database.getPool();
    const now = nowFn(this.database.dialect);
    
    await pool.query(
      `UPDATE project_scopes SET last_active_at = ${now} WHERE project_id = $1`,
      [projectId]
    );
  }

  /**
   * Get all project scopes
   */
  async getAllProjectScopes(): Promise<any[]> {
    const pool = this.database.getPool();
    
    const result = await pool.query('SELECT * FROM project_scopes ORDER BY last_active_at DESC');
    
    return result.rows as Record<string, unknown>[];
  }

  /**
   * Cleanup expired memories based on TTL
   */
  async cleanupExpiredMemories(): Promise<{ deleted: number; archived: number }> {
    const pool = this.database.getPool();
    const now = nowFn(this.database.dialect);
    
    // Delete memories older than 90 days
    const deleteResult = await pool.query(
      `DELETE FROM memories WHERE created_at < ${now} - interval '90 days'`
    );
    
    // Archive memories older than 30 days but newer than 90 days
    const archiveResult = await pool.query(
      `UPDATE memories
        SET metadata = jsonb_set(metadata, '{archived}', 'true')
        WHERE created_at < ${now} - interval '30 days'
        AND created_at >= ${now} - interval '90 days'
        AND (${jsonExtractText(this.database.dialect, 'metadata', 'archived')}) IS DISTINCT FROM 'true'`
    );
    
    // Clean up old candidates
    await pool.query(
      `DELETE FROM memory_candidates WHERE status = $1 AND created_at < ${now} - interval '7 days'`,
      ['rejected']
    );
    
    return {
      deleted: deleteResult.rowCount || 0,
      archived: archiveResult.rowCount || 0,
    };
  }

  // ==================== Event Operations ====================

  /**
   * Emit an event to the event bus
   */
  async emitEvent(channel: string, payload: Record<string, unknown>, sessionId?: string): Promise<void> {
    const pool = this.database.getPool();
    
    try {
      await pool.query(
        `INSERT INTO memory_events (channel, payload, session_id)
         VALUES ($1, $2, $3)`,
        [channel, JSON.stringify(payload), sessionId]
      );
    } catch (error) {
      getLogger().error('Failed to emit event', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Get events since a specific ID
   */
  async getEventsSince(sinceId: number, limit: number = 100): Promise<{ channel: string; payload: Record<string, unknown>; createdAt: Date }[]> {
    const pool = this.database.getPool();
    
    const result = await pool.query(
      `SELECT channel, payload, created_at
       FROM memory_events
       WHERE id > $1
       ORDER BY id ASC
       LIMIT $2`,
      [sinceId, limit]
    );

    return result.rows.map((row: unknown) => {
      const r = row as Record<string, unknown>;
      return {
        channel: r.channel as string,
        payload: parseJsonField(this.database.dialect, r.payload),
        createdAt: toDate(this.database.dialect, r.created_at),
      };
    });
  }

  // ==================== Cleanup ====================

  async cleanup(): Promise<void> {
    // No persistent resources to clean up
    getLogger().debug('Cleanup complete');
  }

  // ==================== Mapping Helpers ====================

  private mapSession(row: Record<string, unknown>): Session {
    return {
      id: row.id as string,
      projectId: row.project_id as string | undefined,
      workspaceId: row.workspace_id as string | undefined,
      directory: row.directory as string | undefined,
      title: row.title as string,
      summary: row.summary as string | undefined,
      turnCount: (row.turn_count as number | undefined) ?? 0,
      createdAt: toDate(this.database.dialect, row.created_at),
      updatedAt: toDate(this.database.dialect, row.updated_at),
    };
  }

  private mapMemory(row: Record<string, unknown>): Memory {
    const tags = parseArrayField(this.database.dialect, row.tags);
    const linkedMemoryIds = parseArrayField(this.database.dialect, row.linked_memory_ids);
    return {
      id: row.id as number,
      sessionId: row.session_id as string | undefined,
      projectId: row.project_id as string | undefined,
      memoryType: row.memory_type as MemoryType,
      content: row.content as string,
      importance: row.importance as number,
      emotion: row.emotion as MemoryEmotion,
      confidence: row.confidence as number,
      source: row.source as MemorySource,
      tags: tags as string[],
      linkedMemoryIds: linkedMemoryIds as number[],
      metadata: parseJsonField(this.database.dialect, row.metadata),
      createdAt: toDate(this.database.dialect, row.created_at),
      updatedAt: toDate(this.database.dialect, row.updated_at),
      accessedAt: toDate(this.database.dialect, row.accessed_at),
      accessCount: row.access_count as number,
    };
  }

  async pruneMemories(config?: Partial<PruneConfig>): Promise<PruneReport> {
    const fullConfig = { ...DEFAULT_PRUNE_CONFIG, ...config };
    const result = await this.loadPruneRows();

    const memories: Memory[] = result.rows.map((row: unknown) => {
      const r = row as Record<string, unknown>;
      const memory = this.mapMemory(r);
      const graphLinks = r.graph_links == null ? 0 : Number(r.graph_links);
      const recallCount = r.recall_count == null ? 0 : Number(r.recall_count);
      return {
        ...memory,
        graphLinks,
        recallCount,
      };
    });

    return pruneMemories(memories, fullConfig);
  }

  private async loadBackfillRows(
    options: BackfillEmbeddingsOptions,
  ): Promise<Array<{ id: number; content: string }>> {
    const pool = this.database.getPool();
    const params: unknown[] = [];
    let sql = `SELECT id, content FROM memories WHERE embedding IS NULL`;

    if (options.projectId) {
      params.push(options.projectId);
      sql += ` AND project_id = $${params.length}`;
    }

    params.push(options.limit);
    sql += ` ORDER BY created_at ASC LIMIT $${params.length}`;
    const result = await pool.query(sql, params);
    return result.rows as Array<{ id: number; content: string }>;
  }

  private async storeEmbedding(
    memoryId: number,
    content: string,
    embedding: number[],
  ): Promise<void> {
    const pool = this.database.getPool();
    const vector = `[${embedding.join(',')}]`;
    const now = nowFn(this.database.dialect);
    await pool.query(
      `UPDATE memories SET embedding = $1, updated_at = ${now} WHERE id = $2`,
      [vector, memoryId],
    );
    await pool.query(
      `INSERT INTO memory_chunks
       (memory_id, chunk_index, content, token_count, embedding, embedding_model)
       VALUES ($1, 0, $2, $3, $4, $5)
       ON CONFLICT (memory_id, chunk_index) DO UPDATE SET
         content = EXCLUDED.content,
         token_count = EXCLUDED.token_count,
         embedding = EXCLUDED.embedding,
         embedding_model = EXCLUDED.embedding_model`,
      [memoryId, content, Math.ceil(content.length / 4), vector, 'hash-fallback'],
    );
  }

  private async recordRecalls(
    entries: Array<{ memory: Memory; score: number }>,
    query: string,
    projectId?: string,
    telemetry?: { sessionId?: string; source?: RecallTelemetrySource },
  ): Promise<void> {
    if (entries.length === 0) return;

    const pool = this.database.getPool();
    try {
      await recordRecallBatch(
        pool,
        entries.map((entry, index) => ({
          memoryId: entry.memory.id,
          sessionId: telemetry?.sessionId,
          projectId: entry.memory.projectId ?? projectId ?? null,
          query,
          source: telemetry?.source ?? 'search',
          rank: index + 1,
          score: entry.score,
        })),
      );
    } catch (error) {
      getLogger().error('Recall telemetry write failed', error instanceof Error ? error : undefined);
    }
  }

  private describeListQuery(options: MemoryListOptions): string {
    return JSON.stringify({
      type: options.type ?? null,
      tags: options.tags ?? [],
      projectId: options.projectId ?? null,
      entityType: options.entityType ?? null,
      entityValue: options.entityValue ?? null,
      sessionId: options.sessionId ?? null,
      sortBy: options.sortBy ?? 'recent',
    });
  }

  private async loadPruneRows(): Promise<{ rows: unknown[] }> {
    const pool = this.database.getPool();

    try {
      return await pool.query(`
        SELECT m.*,
          COALESCE(g.link_count, 0) AS graph_links,
          COALESCE(r.recall_count, 0) AS recall_count
        FROM memories m
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS link_count
          FROM memory_links
          WHERE source_id = m.id OR target_id = m.id
        ) g ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS recall_count
          FROM memory_recall_events
          WHERE memory_id = m.id
        ) r ON true
        ORDER BY m.created_at ASC
      `);
    } catch {
      return pool.query(`
        SELECT m.*,
          COALESCE(g.link_count, 0) AS graph_links,
          0::int AS recall_count
        FROM memories m
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS link_count
          FROM memory_links
          WHERE source_id = m.id OR target_id = m.id
        ) g ON true
        ORDER BY m.created_at ASC
      `);
    }
  }
}

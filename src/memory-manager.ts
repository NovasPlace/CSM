// Memory Manager - CRUD operations with dual-write pattern
// Inspired by Agent Atlas memory_bridge.py

import { Database } from './database.js';
import { EmbeddingGenerator } from './embeddings.js';
import { extractConcepts } from './concept-extractor.js';
import { buildLinksForMemory, findSharedEntities } from './memory-graph.js';
import { hybridSearch, DEFAULT_WEIGHTS, type HybridWeights } from './hybrid-search.js';
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
} from './types.js';

export class MemoryManager {
  private database: Database;
  private embeddings: EmbeddingGenerator;

  constructor(database: Database, embeddings: EmbeddingGenerator) {
    this.database = database;
    this.embeddings = embeddings;
  }

  // ==================== Session Operations ====================

  /**
   * Create a new session
   */
  async createSession(sessionId: string, projectPath: string): Promise<Session> {
    const pool = this.database.getPool();
    
    // Check if session already exists
    const existing = await pool.query(
      'SELECT * FROM sessions WHERE id = $1',
      [sessionId]
    );

    if (existing.rows.length > 0) {
      return this.mapSession(existing.rows[0] as Record<string, unknown>);
    }

    // Insert new session
    const result = await pool.query(
      `INSERT INTO sessions (id, directory, title, project_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [sessionId, projectPath, `Session ${new Date().toISOString()}`, projectPath]
    );

    const row = result.rows[0] as Record<string, unknown>;
    
    await this.emitEvent('session.created', { sessionId: row.id });

    return this.mapSession(row);
  }

  /**
   * Archive a session (mark as ended)
   */
  async archiveSession(sessionId: string, summary?: string): Promise<void> {
    const pool = this.database.getPool();
    
    await pool.query(
      `UPDATE sessions 
       SET updated_at = now(), summary = COALESCE($1, summary)
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
    
    const result = await pool.query(
      `SELECT * FROM sessions 
       WHERE directory = $1 OR project_id = $1
       ORDER BY updated_at DESC
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
      const pool = this.database.getPool();
      
      // Get project_id from session if available
      let projectId: string | null = null;
      if (options.sessionId) {
        const sessionResult = await pool.query(
          'SELECT project_id FROM sessions WHERE id = $1',
          [options.sessionId]
        );
        if (sessionResult.rows.length > 0) {
          const row = sessionResult.rows[0] as { project_id: string | null };
          projectId = row.project_id ?? null;
        }
      }
      
      // Extract concepts from content
      const extraction = extractConcepts(options.content);
      const extracted = extraction.concepts;
      const mergedMetadata = { ...(options.metadata ?? {}), extracted_concepts: extracted };
      const mergedTags = Array.from(new Set([...(options.tags ?? []), ...extracted.map(c => c.value)]));
  
      // Generate embedding first
      let embedding: number[] | null = null;
      try {
        embedding = await this.embeddings.generate(options.content);
      } catch (error) {
        console.error('[MemoryManager] Failed to generate embedding:', error);
      }
  
      // Insert memory with embedding
      const result = await pool.query(
        `INSERT INTO memories (
          session_id, project_id, memory_type, content, importance, emotion,
          confidence, source, tags, linked_memory_ids, metadata, embedding
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          options.sessionId,
          projectId,
          options.type,
          options.content,
          options.importance ?? 0.5,
          options.emotion ?? 'neutral',
          options.confidence ?? 1.0,
          options.source ?? 'manual',
          mergedTags,
          options.linkedMemoryIds ?? [],
          mergedMetadata,
          embedding ? `[${embedding.join(',')}]` : null,
        ]
      );
  
      const memory = this.mapMemory(result.rows[0] as Record<string, unknown>);
  
      // Dual-write: Store embedding in memory_chunks too
      if (embedding) {
        try {
          await pool.query(
            `INSERT INTO memory_chunks (memory_id, chunk_index, content, token_count, embedding, embedding_model)
             VALUES ($1, 0, $2, $3, $4, $5)`,
            [
              memory.id,
              options.content,
              Math.ceil(options.content.length / 4), // Rough token estimate
              `[${embedding.join(',')}]`,
              'hash-fallback', // Will be replaced with actual model name
            ]
          );
        } catch (error) {
          console.error('[MemoryManager] Failed to store embedding chunk:', error);
        }
      }
  
      // Emit event
      await this.emitEvent('memory.created', { memoryId: memory.id, type: options.type });
  
      // Build graph links for this memory
      try {
        const extracted = extractConcepts(options.content);
        await buildLinksForMemory(this.database, memory.id, extracted.concepts);
      } catch (error) {
        console.error('[MemoryManager] Failed to build graph links:', error);
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
       SET accessed_at = now(), access_count = access_count + 1
       WHERE id = $1`,
      [id]
    );
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
  async searchMemories(options: MemorySearchOptions): Promise<{ memory: Memory; score: number }[]> {
    const pool = this.database.getPool();
    const queryEmbedding = await this.embeddings.generate(options.query);

    try {
      const results = await hybridSearch(
        this.database,
        options.query,
        queryEmbedding,
        options.limit ?? 10,
        { projectId: options.projectId, type: options.type, weights: (options as any).weights },
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
      return memories;
    } catch (err) {
      console.warn('[MemoryManager] Hybrid search failed, falling back to vector-only:', err);
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

    const result = await pool.query(sql, params);
    const memories: { memory: Memory; score: number }[] = [];
    for (const row of result.rows) {
      const memory = this.mapMemory(row as Record<string, unknown>);
      const score = (row as Record<string, unknown>).similarity as number;
      await this.touchMemory(memory.id);
      memories.push({ memory, score });
    }
    return memories;
  }

  /**
   * List memories with filters
   */
  async listMemories(options: MemoryListOptions = {}): Promise<Memory[]> {
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
      query += ` AND tags && $${paramIndex}`;
      params.push(options.tags);
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
      query += ` AND metadata->'concepts' @> $${paramIndex}`;
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

    return result.rows.map(row => this.mapMemory(row as Record<string, unknown>));
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
    
    const result = await pool.query(
      `SELECT * FROM memories 
       WHERE project_id = $1
       ORDER BY created_at DESC
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
    
    await pool.query(
      `INSERT INTO project_scopes (project_id, name, directory, last_active_at)
       VALUES ($1, $2, $3, now())
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
    
    await pool.query(
      'UPDATE project_scopes SET last_active_at = now() WHERE project_id = $1',
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
    
    // Delete memories older than 90 days
    const deleteResult = await pool.query(
      'DELETE FROM memories WHERE created_at < now() - interval \'90 days\''
    );
    
    // Archive memories older than 30 days but newer than 90 days
    const archiveResult = await pool.query(
      `UPDATE memories 
       SET metadata = jsonb_set(metadata, '{archived}', 'true')
       WHERE created_at < now() - interval \'30 days\'
       AND created_at >= now() - interval \'90 days\'
       AND (metadata->>'archived') IS DISTINCT FROM 'true'`
    );
    
    // Clean up old candidates
    await pool.query(
      'DELETE FROM memory_candidates WHERE status = $1 AND created_at < now() - interval \'7 days\'',
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
      console.error('[MemoryManager] Failed to emit event:', error);
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
        payload: r.payload as Record<string, unknown>,
        createdAt: r.created_at as Date,
      };
    });
  }

  // ==================== Cleanup ====================

  async cleanup(): Promise<void> {
    // No persistent resources to clean up
    console.log('[MemoryManager] Cleanup complete');
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
      turnCount: row.turn_count as number,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  }

  private mapMemory(row: Record<string, unknown>): Memory {
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
      tags: row.tags as string[],
      linkedMemoryIds: row.linked_memory_ids as number[],
      metadata: row.metadata as Record<string, unknown>,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
      accessedAt: row.accessed_at as Date,
      accessCount: row.access_count as number,
    };
  }
}

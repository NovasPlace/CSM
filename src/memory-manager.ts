// Memory Manager - CRUD operations with dual-write pattern
// Inspired by Agent Atlas memory_bridge.py

import { Database } from './database.js';
import { EmbeddingGenerator } from './embeddings.js';
import { extractConcepts } from './concept-extractor.js';
import { buildLinksForMemory } from './memory-graph.js';
import { hybridSearch } from './hybrid-search.js';
import { pruneMemories } from './prune-scorer.js';
import { Redactor, redactJsonValue } from './redactor.js';
import { DEFAULT_PRUNE_CONFIG } from './types.js';
import { recordRecallBatch, type RecallTelemetrySource } from './recall-telemetry.js';
import { applyTypeQuota } from './memory-type-quota.js';
import { getLogger } from './logger.js';
import { nowFn, ilikeExpr, jsonKeyExists, jsonExtractText, jsonArrayContains, jsonArrayContainsAll, jsonContainsPath, isUniqueViolation, jsonParam, toDate, parseArrayField, parseJsonField, colInParamArray } from './db/query-dialect.js';
import { HybridWeights } from './hybrid-search.js';
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
  ProjectScope,
  MemoryCleanupOptions,
  MemoryCleanupReport,
} from './types.js';

// Helper function to map database row to ProjectScope
function mapProjectScope(row: Record<string, unknown>): ProjectScope {
  return {
    projectId: row.project_id as string,
    name: row.name as string,
    directory: row.directory as string,
    createdAt: new Date(row.created_at as string),
    lastActiveAt: new Date(row.last_active_at as string),
    memoryCount: row.memory_count as number,
  };
}

function isPastRetention(
  row: { memory_type: MemoryType; importance: number; created_at: unknown },
  ttl: MemoryCleanupOptions['ttl'],
): boolean {
  const createdAt = toDate('pg', row.created_at);
  if (!Number.isFinite(createdAt.getTime())) return false;
  const typeDays = ttl.byType[row.memory_type] ?? ttl.defaultDays;
  const importance = Number(row.importance);
  const importanceDays = ttl.byImportance.find((range, index) => (
    importance >= range.min
    && (importance < range.max || (index === ttl.byImportance.length - 1 && importance <= range.max))
  ))?.days ?? ttl.defaultDays;
  const retentionDays = Math.max(typeDays, importanceDays, ttl.gracePeriodDays);
  return Date.now() - createdAt.getTime() >= retentionDays * 86_400_000;
}

function isMissingSqliteTable(
  dialect: 'pg' | 'sqlite',
  error: unknown,
  table: string,
): boolean {
  return dialect === 'sqlite'
    && error instanceof Error
    && error.message.includes(`no such table: ${table}`);
}

export class MemoryManager {
  private database: Database;
  private embeddings: EmbeddingGenerator;
  redactor?: Redactor;

  constructor(database: Database, embeddings: EmbeddingGenerator, redactor: Redactor = new Redactor()) {
    this.database = database;
    this.embeddings = embeddings;
    this.redactor = redactor;
  }

  /**
   * Format embedding model name for telemetry storage in memory_chunks.embedding_model.
   * Returns 'provider:model' (e.g. 'ollama:nomic-embed-text') or 'hash-fallback' for dev mode.
   */
  private formatEmbeddingModel(): string {
    const info = this.embeddings.getProviderInfo();
    return `${info.provider}:${info.model}`;
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
    const safeSummary = summary === undefined || !this.redactor
      ? summary
      : this.redactor.redact(summary).text;
    
    await pool.query(
      `UPDATE sessions 
       SET updated_at = ${nowFn(this.database.dialect)},
           ended_at = ${nowFn(this.database.dialect)},
           summary = COALESCE($1, summary)
       WHERE id = $2`,
      [safeSummary, sessionId]
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
       ORDER BY updated_at DESC, created_at DESC
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

      // Resolve and verify project ownership before deduplication or storage.
      // A session ID must never be reused to write into a different project.
      let projectId: string | null = options.projectId ?? null;
      if (options.sessionId) {
        const sessionResult = await pool.query(
          'SELECT project_id FROM sessions WHERE id = $1',
          [options.sessionId],
        );
        if (sessionResult.rows.length > 0) {
          const row = sessionResult.rows[0] as { project_id: string | null };
          const sessionProjectId = row.project_id ?? null;
          if (projectId && sessionProjectId && projectId !== sessionProjectId) {
            throw new Error(
              `Session ${options.sessionId} belongs to project ${sessionProjectId}; refusing memory write for ${projectId}`,
            );
          }
          if (projectId && !sessionProjectId) {
            await pool.query(
              'UPDATE sessions SET project_id = $2, directory = COALESCE(directory, $2) WHERE id = $1 AND project_id IS NULL',
              [options.sessionId, projectId],
            );
          }
          projectId ??= sessionProjectId;
        } else {
          const recoveredProjectId = projectId ?? process.cwd();
          await pool.query(
            `INSERT INTO sessions (id, directory, title, project_id)
             VALUES ($1, $2, $3, $2)
             ON CONFLICT (id) DO NOTHING`,
            [options.sessionId, recoveredProjectId, 'recovered-session'],
          );
          projectId = recoveredProjectId;
        }
      }

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

      // Phase 18 â€” Redact content BEFORE any processing (concepts, embeddings, storage)
      let contentToProcess = options.content;
      if (this.redactor) {
        const redactionResult = this.redactor.redact(options.content);
        contentToProcess = redactionResult.text;
      }

      // Metadata and tags can carry the same caller-controlled values as content.
      // Redact them structurally while preserving the transcript message ID used
      // by the deduplication join.
      let metadataToPersist = options.metadata ?? {};
      let tagsToPersist = options.tags ?? [];
      if (this.redactor) {
        metadataToPersist = redactJsonValue(this.redactor, metadataToPersist);
        tagsToPersist = redactJsonValue(this.redactor, tagsToPersist);
        if (transcriptMsgId != null) metadataToPersist.messageId = transcriptMsgId;
      }

      // Phase 5 â€” Apply per-type content quota (compress success/episodic, preserve errors/lessons)
      const quotaResult = applyTypeQuota(contentToProcess, options.type, options.emotion);
      if (quotaResult.compressed) {
        // The summary is what gets embedded and stored; the original never reaches the DB.
        getLogger().warn(
          `Memory of type '${options.type}' exceeded its quota and was COMPRESSED before embedding `
          + `and storage: ${quotaResult.originalTokens} -> ${quotaResult.finalTokens} tokens. `
          + `The original text is NOT recoverable. Use type='lesson' for long durable facts.`,
        );
      }
      contentToProcess = quotaResult.content;
      
      // Extract concepts from content
      const extraction = extractConcepts(contentToProcess);
      const extracted = extraction.concepts;
      const mergedMetadata = { ...metadataToPersist, extracted_concepts: extracted };
      const mergedTags = Array.from(new Set([...tagsToPersist, ...extracted.map(c => c.value)]));
  
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
              this.formatEmbeddingModel(),
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

  /**
   * Update memory metadata (merge with existing)
   */
  async updateMemoryMetadata(id: number, patch: Record<string, unknown>): Promise<void> {
    const pool = this.database.getPool();
    const dialect = this.database.dialect;

    const result = await pool.query(
      dialect === 'sqlite'
        ? `SELECT metadata FROM memories WHERE id = $1`
        : `SELECT metadata FROM memories WHERE id = $1`,
      [id],
    );

    if (!result.rows[0]) return;
    const row = result.rows[0] as { metadata?: string | Record<string, unknown> | null };
    const existing = typeof row.metadata === 'string'
      ? JSON.parse(row.metadata || '{}')
      : (row.metadata ?? {});
    const merged = { ...existing, ...patch };
    const messageId = merged.messageId;
    const safeMerged = this.redactor
      ? redactJsonValue(this.redactor, merged)
      : merged;
    if (messageId != null) safeMerged.messageId = messageId;

    await pool.query(
      `UPDATE memories SET metadata = $1 WHERE id = $2`,
      [JSON.stringify(safeMerged), id],
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
        const safeContent = this.redactor
          ? this.redactor.redact(row.content).text
          : row.content;
        const embedding = await this.embeddings.generate(safeContent);
        await this.storeEmbedding(row.id, safeContent, embedding);
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
  async deleteMemory(id: number, projectId: string): Promise<boolean> {
    const pool = this.database.getPool();
    
    const result = await pool.query(
      'DELETE FROM memories WHERE id = $1 AND project_id = $2 RETURNING id',
      [id, projectId]
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
    options: MemorySearchOptions & { weights?: HybridWeights },
    telemetry?: { sessionId?: string; source?: RecallTelemetrySource },
  ): Promise<{ memory: Memory; score: number }[]> {
    const pool = this.database.getPool();
    const safeQuery = this.redactor
      ? this.redactor.redact(options.query).text
      : options.query;
    const compatibleTags = this.compatibleSearchTags(options.tags);
    const lexicalQueries = Array.from(new Set([safeQuery, options.query]));
    const requestedScope = options.searchMode ?? 'project';
    if (requestedScope === 'project' && !options.projectId) {
      const memories: { memory: Memory; score: number }[] = [];
      await this.recordRecalls(memories, safeQuery, undefined, telemetry, 'empty_result');
      return memories;
    }

    // SQLite: skip vector search entirely, go to text fallback
    if (this.database.dialect === 'sqlite') {
      getLogger().debug('SQLite: skipping vector search, using text fallback');
      const memories = await this.textSearchFallback(options);
      await this.recordRecalls(memories, options.query, options.projectId, telemetry, 'text_only');
      return memories;
    }

    // Only protected text may leave the process for a configured embedding provider.
    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.embeddings.generate(safeQuery);
    } catch (embedErr) {
      getLogger().warn('Embedding query generation failed; falling back to text-only search', { reason: embedErr instanceof Error ? embedErr.message : String(embedErr) });
      const memories = await this.textSearchFallback(options);
      await this.recordRecalls(memories, options.query, options.projectId, telemetry, 'text_fallback');
      return memories;
    }

    try {
      const results = await hybridSearch(
        this.database,
        safeQuery,
        queryEmbedding,
        options.limit ?? 10,
        {
          projectId: options.projectId,
          type: options.type,
          tags: compatibleTags,
          minImportance: options.minImportance,
          searchMode: options.searchMode,
          weights: options.weights,
          lexicalQueries,
        },
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
    if (searchMode === 'project') {
      if (options.projectId) {
        sql += ` AND m.project_id = $${paramIndex}`;
        params.push(options.projectId);
        paramIndex++;
      } else {
        sql += ' AND 1=0';
      }
    } else if (searchMode === 'legacy') {
      if (options.projectId) {
        sql += ` AND (m.project_id = $${paramIndex} OR m.project_id IS NULL)`;
        params.push(options.projectId);
        paramIndex++;
      } else {
        sql += ' AND m.project_id IS NULL';
      }
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
    if (compatibleTags && compatibleTags.length > 0) {
      sql += ` AND m.tags && $${paramIndex}`;
      params.push(compatibleTags);
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
        memories.push({ memory, score });
      }
      let combined = memories;
      if (lexicalQueries.length > 1 || compatibleTags?.length !== options.tags?.length) {
        const lexicalMatches = await this.textSearchFallback(options, false);
        const seen = new Set<number>();
        combined = [...lexicalMatches, ...memories].filter(({ memory }) => {
          if (seen.has(memory.id)) return false;
          seen.add(memory.id);
          return true;
        });
      }
      const limited = combined.slice(0, options.limit ?? 10);
      for (const { memory } of limited) {
        await this.touchMemory(memory.id);
      }
      await this.recordRecalls(limited, safeQuery, options.projectId, telemetry, 'vector_only');
      return limited;
    } catch (_err) {
      getLogger().warn('Vector search failed, falling back to text search');
      const memories = await this.textSearchFallback(options);
      await this.recordRecalls(memories, options.query, options.projectId, telemetry, 'text_fallback');
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

    const searchMode = options.searchMode ?? 'project';
    if (searchMode === 'project') {
      if (options.projectId) {
        query += ` AND project_id = $${paramIndex}`;
        params.push(options.projectId);
        paramIndex++;
      } else {
        query += ' AND 1=0';
      }
    } else if (searchMode === 'legacy') {
      if (options.projectId) {
        query += ` AND (project_id = $${paramIndex} OR project_id IS NULL)`;
        params.push(options.projectId);
        paramIndex++;
      } else {
        query += ' AND project_id IS NULL';
      }
    }

    if (options.type) {
      query += ` AND memory_type = $${paramIndex}`;
      params.push(options.type);
      paramIndex++;
    }

    if (options.tags && options.tags.length > 0) {
      const safeTags = this.redactor
        ? redactJsonValue(this.redactor, options.tags)
        : options.tags;
      const tagPredicate = options.tagsMatch === 'all' ? jsonArrayContainsAll : jsonArrayContains;
      query += ` AND (${tagPredicate(this.database.dialect, 'tags', paramIndex)} OR ${tagPredicate(this.database.dialect, 'tags', paramIndex + 1)})`;
      params.push(jsonParam(this.database.dialect, options.tags));
      params.push(jsonParam(this.database.dialect, safeTags));
      paramIndex += 2;
    }

    if (options.sessionId) {
      query += ` AND session_id = $${paramIndex}`;
      params.push(options.sessionId);
      paramIndex++;
    }

    if (options.dateFrom) {
      query += this.database.dialect === 'sqlite'
        ? ` AND julianday(created_at) >= julianday($${paramIndex})`
        : ` AND created_at >= $${paramIndex}`;
      params.push(this.database.dialect === 'sqlite' ? options.dateFrom.toISOString() : options.dateFrom);
      paramIndex++;
    }

    if (options.dateTo) {
      query += this.database.dialect === 'sqlite'
        ? ` AND julianday(created_at) <= julianday($${paramIndex})`
        : ` AND created_at <= $${paramIndex}`;
      params.push(this.database.dialect === 'sqlite' ? options.dateTo.toISOString() : options.dateTo);
      paramIndex++;
    }

    if (options.entityType && options.entityValue) {
      const safeEntityValue = this.redactor
        ? this.redactor.redact(options.entityValue).text
        : options.entityValue;
      if (this.database.dialect === 'sqlite') {
        query += ` AND EXISTS (
          SELECT 1 FROM json_each(json_extract(metadata, '$.extracted_concepts')) AS concept
          WHERE json_extract(concept.value, '$.type') = $${paramIndex}
            AND (json_extract(concept.value, '$.value') = $${paramIndex + 1}
              OR json_extract(concept.value, '$.value') = $${paramIndex + 2})
        )`;
        params.push(options.entityType, options.entityValue, safeEntityValue);
        paramIndex += 3;
      } else {
        query += ` AND (${jsonContainsPath('pg', 'metadata', 'extracted_concepts', paramIndex)} OR ${jsonContainsPath('pg', 'metadata', 'extracted_concepts', paramIndex + 1)})`;
        params.push(JSON.stringify([{ type: options.entityType, value: options.entityValue }]));
        params.push(JSON.stringify([{ type: options.entityType, value: safeEntityValue }]));
        paramIndex += 2;
      }
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

  private compatibleSearchTags(tags?: string[]): string[] | undefined {
    if (!tags?.length) return tags;
    const protectedTags = this.redactor
      ? redactJsonValue(this.redactor, tags)
      : tags;
    return Array.from(new Set([...tags, ...protectedTags]));
  }

  private async textSearchFallback(
    options: MemorySearchOptions,
    touch: boolean = true,
  ): Promise<{ memory: Memory; score: number }[]> {
    const pool = this.database.getPool();
    const safeQuery = this.redactor
      ? this.redactor.redact(options.query).text
      : options.query;
    const queryVariants = Array.from(new Set([options.query, safeQuery]));
    const queryConditions = queryVariants.map((_, index) =>
      ilikeExpr(this.database.dialect, 'content', index + 1));
    let sql = `
      SELECT *
      FROM memories
      WHERE (${queryConditions.join(' OR ')})
    `;
    const params: unknown[] = queryVariants.map((query) => `%${query}%`);
    let paramIndex = params.length + 1;
    const searchMode = options.searchMode ?? 'project';

    if (searchMode === 'project') {
      if (options.projectId) {
        sql += ` AND project_id = $${paramIndex}`;
        params.push(options.projectId);
        paramIndex++;
      } else {
        sql += ' AND 1=0';
      }
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
    const compatibleTags = this.compatibleSearchTags(options.tags);
    if (compatibleTags && compatibleTags.length > 0) {
      sql += ` AND ${jsonArrayContains(this.database.dialect, 'tags', paramIndex)}`;
      params.push(jsonParam(this.database.dialect, compatibleTags));
      paramIndex++;
    }

    sql += ` ORDER BY importance DESC, created_at DESC LIMIT $${paramIndex}`;
    params.push(options.limit ?? 10);

    const result = await pool.query(sql, params);
    const memories: { memory: Memory; score: number }[] = [];
    for (const row of result.rows) {
      const memory = this.mapMemory(row as Record<string, unknown>);
      if (touch) await this.touchMemory(memory.id);
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
    const result = await pool.query(
      `SELECT * FROM memories
       WHERE project_id = $1
       ORDER BY created_at DESC, id DESC
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
    const safeName = this.redactor ? this.redactor.redact(name).text : name;
    
    await pool.query(
      `INSERT INTO project_scopes (project_id, name, directory, last_active_at)
       VALUES ($1, $2, $3, ${now})
       ON CONFLICT (project_id) DO UPDATE SET
       name = EXCLUDED.name,
       directory = EXCLUDED.directory,
       last_active_at = EXCLUDED.last_active_at`,
      [projectId, safeName, directory]
    );
  }

  /**
   * Get project scope by ID
   */
  async getProjectScope(projectId: string): Promise<ProjectScope | null> {
    const pool = this.database.getPool();

    const result = await pool.query('SELECT * FROM project_scopes WHERE project_id = $1', [projectId]);

    if (result.rows.length === 0) {
      return null;
    }

    return mapProjectScope(result.rows[0] as Record<string, unknown>);
  }

  async getDefaultProjectScope(): Promise<Record<string, unknown>> {
    return null as unknown as Record<string, unknown>;
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
  async getAllProjectScopes(): Promise<ProjectScope[]> {
    const pool = this.database.getPool();

    const result = await pool.query('SELECT * FROM project_scopes ORDER BY last_active_at DESC');

    return (result.rows as unknown[]).map((row) => mapProjectScope(row as Record<string, unknown>));
  }

  /**
   * Cleanup expired memories based on TTL
   */
  async cleanupExpiredMemories(options: MemoryCleanupOptions): Promise<MemoryCleanupReport> {
    const pool = this.database.getPool();
    const projectId = options.projectId.trim();
    if (!projectId) throw new Error('projectId is required for memory cleanup');
    const maxDelete = options.maxDelete ?? 1_000;
    if (!Number.isInteger(maxDelete) || maxDelete < 1 || maxDelete > 10_000) {
      throw new Error('maxDelete must be an integer between 1 and 10000');
    }

    const result = await pool.query(
      `SELECT id, memory_type, importance, created_at
       FROM memories
       WHERE project_id = $1
       ORDER BY created_at ASC`,
      [projectId],
    );
    const rows = result.rows as Array<{
      id: number;
      memory_type: MemoryType;
      importance: number;
      created_at: unknown;
    }>;
    const eligibleIds = options.ttl.enabled
      ? rows.filter((row) => isPastRetention(row, options.ttl)).map((row) => row.id)
      : [];
    const selectedIds = eligibleIds.slice(0, maxDelete);
    const report: MemoryCleanupReport = {
      projectId,
      dryRun: options.apply !== true,
      policyEnabled: options.ttl.enabled,
      scanned: rows.length,
      eligible: eligibleIds.length,
      deleted: 0,
      archived: 0,
      rejectedCandidatesDeleted: 0,
      capped: eligibleIds.length > selectedIds.length,
    };
    if (report.dryRun || selectedIds.length === 0) return report;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const deleted = await client.query(
        `DELETE FROM memories
         WHERE project_id = $1
           AND ${colInParamArray(this.database.dialect, 'id', 2)}`,
        [projectId, jsonParam(this.database.dialect, selectedIds)],
      );
      const rejectedCutoff = new Date(Date.now() - 7 * 86_400_000);
      let rejectedCandidatesDeleted = 0;
      try {
        const rejected = await client.query(
          `DELETE FROM memory_candidates
           WHERE project_id = $1 AND status = $2 AND created_at < $3`,
          [projectId, 'rejected', this.database.dialect === 'sqlite' ? rejectedCutoff.toISOString() : rejectedCutoff],
        );
        rejectedCandidatesDeleted = rejected.rowCount ?? 0;
      } catch (error) {
        if (!isMissingSqliteTable(this.database.dialect, error, 'memory_candidates')) throw error;
      }
      await client.query('COMMIT');
      report.deleted = deleted.rowCount ?? 0;
      report.rejectedCandidatesDeleted = rejectedCandidatesDeleted;
      await this.emitEvent('memory.retention_cleanup', {
        projectId,
        deleted: report.deleted,
        rejectedCandidatesDeleted: report.rejectedCandidatesDeleted,
      });
      return report;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  // ==================== Event Operations ====================

  /**
   * Emit an event to the event bus
   */
  async emitEvent(channel: string, payload: Record<string, unknown>, sessionId?: string): Promise<void> {
    const pool = this.database.getPool();
    const safePayload = this.redactor
      ? redactJsonValue(this.redactor, payload)
      : payload;
    for (const identifier of ['sessionId', 'projectId', 'memoryId', 'eventId', 'checkpointId', 'goalId']) {
      if (Object.prototype.hasOwnProperty.call(payload, identifier)) {
        safePayload[identifier] = payload[identifier];
      }
    }
    
    try {
      await pool.query(
        `INSERT INTO memory_events (channel, payload, session_id)
         VALUES ($1, $2, $3)`,
        [channel, JSON.stringify(safePayload), sessionId]
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
      `INSERT INTO memory_chunks
       (memory_id, chunk_index, content, token_count, embedding, embedding_model)
       VALUES ($1, 0, $2, $3, $4, $5)
       ON CONFLICT (memory_id, chunk_index) DO UPDATE SET
         content = EXCLUDED.content,
         token_count = EXCLUDED.token_count,
         embedding = EXCLUDED.embedding,
         embedding_model = EXCLUDED.embedding_model`,
      [memoryId, content, Math.ceil(content.length / 4), vector, this.formatEmbeddingModel()],
    );
    await pool.query(
      `UPDATE memories SET embedding = $1, updated_at = ${now} WHERE id = $2`,
      [vector, memoryId],
    );
  }

  private async recordRecalls(
    entries: Array<{ memory: Memory; score: number }>,
    query: string,
    projectId?: string,
    telemetry?: { sessionId?: string; source?: RecallTelemetrySource },
    sourceOverride?: RecallTelemetrySource,
  ): Promise<void> {
    const pool = this.database.getPool();
    const source = sourceOverride ?? telemetry?.source ?? 'search';
    const safeQuery = this.redactor ? this.redactor.redact(query).text : query;

    try {
      if (entries.length === 0) {
        // Record empty-result recall event (memory_id is NULL) for telemetry coverage
        await recordRecallBatch(pool, [
          {
            memoryId: null,
            sessionId: telemetry?.sessionId,
            projectId: projectId ?? null,
            query: safeQuery,
            source: 'empty_result',
            rank: 0,
            score: null,
          },
        ]);
        return;
      }

      await recordRecallBatch(
        pool,
        entries.map((entry, index) => ({
          memoryId: entry.memory.id,
          sessionId: telemetry?.sessionId,
          projectId: entry.memory.projectId ?? projectId ?? null,
          query: safeQuery,
          source,
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

// ContextRecallDaemon - Rebuilds context brief every 90 seconds
// Inspired by Agent Atlas context_recall.py
// Builds compressed <=50 line context brief from three tiers:
// 1. Episodic: Recent file changes, session events (last 6 hours)
// 2. Procedural: Top lessons primed to current work
// 3. Semantic: Current project states

import { Database } from './database.js';
import { Memory, ContextBrief, ToolCallGroup } from './types.js';
import { recordRecallBatch } from './recall-telemetry.js';
import { getLogger } from './logger.js';

export class ContextRecallDaemon {
  private database: Database;
  private interval: number; // seconds
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentSessionId: string | null = null;
  private currentProjectId: string | null = null;

  constructor(database: Database, interval: number = 90) {
    this.database = database;
    this.interval = interval * 1000; // Convert to milliseconds
  }

  /**
   * Start the daemon
   */
  start(): void {
    if (this.timer) {
      getLogger().debug('ContextRecallDaemon already running');
      return;
    }

    getLogger().info(`ContextRecallDaemon starting (interval: ${this.interval / 1000}s)`);
    
    // Build initial context
    this.buildContext().catch(error => {
      getLogger().error('ContextRecallDaemon initial build failed', error instanceof Error ? error : undefined);
    });

    // Start periodic rebuild
    this.timer = setInterval(() => {
      this.buildContext().catch(error => {
        getLogger().error('ContextRecallDaemon periodic build failed', error instanceof Error ? error : undefined);
      });
    }, this.interval);
  }

  /**
   * Stop the daemon
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      getLogger().info('ContextRecallDaemon stopped');
    }
  }

  /**
   * Set current session context
   */
  setSession(sessionId: string, projectId: string): void {
    this.currentSessionId = sessionId;
    this.currentProjectId = projectId;
  }

  /**
   * Refresh context for a known active session immediately.
   */
  async refreshSession(sessionId: string, projectId: string): Promise<ContextBrief> {
    this.setSession(sessionId, projectId);
    return this.buildContext();
  }

  /**
   * Get current context brief
   */
  async getContextBrief(): Promise<ContextBrief | null> {
    const pool = this.database.getPool();

    if (!this.currentSessionId) {
      return null;
    }

    // Check for cached context brief
    const result = await pool.query(
      `SELECT * FROM session_contexts 
       WHERE session_id = $1 AND expires_at > now()
       ORDER BY built_at DESC
       LIMIT 1`,
      [this.currentSessionId]
    );

    if (result.rows.length > 0) {
      const row = result.rows[0] as Record<string, unknown>;
      return {
        episodic: row.episodic_memories as Memory[],
        procedural: row.procedural_memories as Memory[],
        semantic: row.semantic_memories as Memory[],
        compressed: row.context_brief as string,
      };
    }

    // Build fresh context
    return this.buildContext();
  }

  /**
   * Build context brief from three tiers plus distilled tool activity
   */
  async buildContext(): Promise<ContextBrief> {
    const pool = this.database.getPool();

    // 1. Episodic: Recent file changes, session events (last 6 hours)
    const episodic = await this.getEpisodicMemories();

    // 2. Procedural: Top lessons primed to current work
    const procedural = await this.getProceduralMemories();

    // 3. Semantic: Current project states
    const semantic = await this.getSemanticMemories();

    // 4. Distilled: Recent tool-call activity summaries
    const distilled = await this.getRecentDistilledSummaries();

    // Compress into <=50 lines
    const compressed = this.compressContext(episodic, procedural, semantic, distilled);

    // Cache the context brief
    if (this.currentSessionId) {
      await pool.query(
        `INSERT INTO sessions (id, directory, title, project_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [
          this.currentSessionId,
          this.currentProjectId ?? process.cwd(),
          `Session ${new Date().toISOString()}`,
          this.currentProjectId ?? 'global',
        ]
      );
      await pool.query(
        `INSERT INTO session_contexts (session_id, context_brief, episodic_memories, procedural_memories, semantic_memories)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          this.currentSessionId,
          compressed,
          JSON.stringify(episodic),
          JSON.stringify(procedural),
          JSON.stringify(semantic),
        ]
      );
      await this.logContextRecall([...episodic, ...procedural, ...semantic]);
    }

    return { episodic, procedural, semantic, distilled, compressed };
  }

  /**
   * Get recent distilled tool-call summaries for the current session
   */
  private async getRecentDistilledSummaries(): Promise<ToolCallGroup[]> {
    const pool = this.database.getPool();

    if (!this.currentSessionId) return [];

    const result = await pool.query(
      `SELECT groups FROM distilled_summaries
       WHERE session_id = $1
       ORDER BY built_at DESC
       LIMIT 3`,
      [this.currentSessionId],
    );

    if (result.rows.length === 0) return [];

    const allGroups: ToolCallGroup[] = [];
    for (const row of result.rows) {
      const groups = (row as Record<string, unknown>).groups as ToolCallGroup[];
      if (Array.isArray(groups)) {
        allGroups.push(...groups);
      }
    }

    // Rows are newest first; keep the most recent groups.
    return allGroups.slice(0, 10);
  }

  /**
   * Get episodic memories (last 6 hours)
   */
  private async getEpisodicMemories(): Promise<Memory[]> {
    const pool = this.database.getPool();

    let query = `
      SELECT * FROM memories
      WHERE memory_type IN ('episodic', 'conversation')
      AND created_at > NOW() - INTERVAL '6 hours'
    `;
    const params: unknown[] = [];
    let paramIndex = 1;

    if (this.currentProjectId) {
      query += ` AND project_id = $${paramIndex}`;
      params.push(this.currentProjectId);
      paramIndex++;
    }

    query += ' ORDER BY created_at DESC LIMIT 20';

    const result = await pool.query(query, params);
    return result.rows.map(row => this.mapMemory(row as Record<string, unknown>));
  }

  /**
   * Get procedural memories (lessons, how-to steps)
   */
  private async getProceduralMemories(): Promise<Memory[]> {
    const pool = this.database.getPool();

    let query = `
      SELECT * FROM memories
      WHERE memory_type IN ('lesson', 'procedural')
    `;
    const params: unknown[] = [];
    let paramIndex = 1;

    if (this.currentProjectId) {
      query += ` AND project_id = $${paramIndex}`;
      params.push(this.currentProjectId);
      paramIndex++;
    }

    query += ' ORDER BY importance DESC, accessed_at DESC LIMIT 10';

    const result = await pool.query(query, params);
    return result.rows.map(row => this.mapMemory(row as Record<string, unknown>));
  }

  /**
   * Get semantic memories (project states, workspace context)
   */
  private async getSemanticMemories(): Promise<Memory[]> {
    const pool = this.database.getPool();

    let query = `
      SELECT * FROM memories
      WHERE memory_type IN ('workspace', 'repo', 'preference')
    `;
    const params: unknown[] = [];
    let paramIndex = 1;

    if (this.currentProjectId) {
      query += ` AND project_id = $${paramIndex}`;
      params.push(this.currentProjectId);
      paramIndex++;
    }

    query += ' ORDER BY importance DESC, updated_at DESC LIMIT 10';

    const result = await pool.query(query, params);
    return result.rows.map(row => this.mapMemory(row as Record<string, unknown>));
  }

  /**
   * Compress context into <=50 lines
   */
  private compressContext(
    episodic: Memory[],
    procedural: Memory[],
    semantic: Memory[],
    distilled: ToolCallGroup[] = [],
  ): string {
    const lines: string[] = [];
    
    lines.push('=== CROSS-SESSION MEMORY CONTEXT ===');
    lines.push('');

    // Distilled tool activity (max 12 lines) — shown first for high signal
    if (distilled.length > 0) {
      lines.push('## Recent Tool Activity (Distilled)');
      for (const group of distilled.slice(0, 6)) {
        const status =
          group.outcome === 'success' ? 'OK'
          : group.outcome === 'failure' ? 'FAIL'
          : group.outcome === 'partial' ? 'PARTIAL'
          : '?';
        lines.push(`- [${status}] ${this.formatDistilledGroup(group)}`);
      }
      lines.push('');
    }

    // Episodic (max 12 lines)
    if (episodic.length > 0) {
      lines.push('## Recent Events (Episodic)');
      for (const memory of episodic.slice(0, 4)) {
        const preview = memory.content.substring(0, 80).replace(/\n/g, ' ');
        lines.push(`- [${memory.source}] ${preview}${memory.content.length > 80 ? '...' : ''}`);
      }
      lines.push('');
    }

    // Procedural (max 12 lines)
    if (procedural.length > 0) {
      lines.push('## Lessons Learned (Procedural)');
      for (const memory of procedural.slice(0, 4)) {
        const preview = memory.content.substring(0, 80).replace(/\n/g, ' ');
        lines.push(`- [${memory.emotion}] ${preview}${memory.content.length > 80 ? '...' : ''}`);
      }
      lines.push('');
    }

    // Semantic (max 12 lines)
    if (semantic.length > 0) {
      lines.push('## Project Context (Semantic)');
      for (const memory of semantic.slice(0, 4)) {
        const preview = memory.content.substring(0, 80).replace(/\n/g, ' ');
        lines.push(`- [${memory.memoryType}] ${preview}${memory.content.length > 80 ? '...' : ''}`);
      }
      lines.push('');
    }

    // Trim to 50 lines max
    const trimmed = lines.slice(0, 50);
    return trimmed.join('\n');
  }

  private formatDistilledGroup(group: ToolCallGroup): string {
    const detail = group.outcome === 'success' && group.filesChanged.length > 0
      ? group.intent
      : group.proceduralInsight ?? group.intent;
    const insight = detail.replace(/\n/g, ' ');
    const files = group.filesChanged
      .map((file) => file.split(/[\\/]/).pop() ?? file)
      .slice(0, 4);
    const suffix = files.length > 0
      ? ` | files: ${files.join(', ')}${group.filesChanged.length > files.length ? ', ...' : ''}`
      : '';
    const maxInsightLength = Math.max(40, 120 - suffix.length);
    const preview = insight.substring(0, maxInsightLength);
    return `${preview}${insight.length > maxInsightLength ? '...' : ''}${suffix}`;
  }

  /**
   * Map database row to Memory object
   */
  private mapMemory(row: Record<string, unknown>): Memory {
    return {
      id: row.id as number,
      sessionId: row.session_id as string | undefined,
      memoryType: row.memory_type as Memory['memoryType'],
      content: row.content as string,
      importance: row.importance as number,
      emotion: row.emotion as Memory['emotion'],
      confidence: row.confidence as number,
      source: row.source as Memory['source'],
      tags: row.tags as string[],
      linkedMemoryIds: row.linked_memory_ids as number[],
      metadata: row.metadata as Record<string, unknown>,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
      accessedAt: row.accessed_at as Date,
      accessCount: row.access_count as number,
    };
  }

  private async logContextRecall(memories: Memory[]): Promise<void> {
    if (!this.currentSessionId || memories.length === 0) return;

    const pool = this.database.getPool();
    try {
      await recordRecallBatch(
        pool,
        memories.map((memory, index) => ({
          memoryId: memory.id,
          sessionId: this.currentSessionId,
          projectId: memory.projectId ?? this.currentProjectId,
          query: `context:${this.currentProjectId ?? 'global'}`,
          source: 'context_recall',
          rank: index + 1,
          score: memory.importance,
        })),
      );
    } catch (error) {
      getLogger().error('Recall telemetry write failed', error instanceof Error ? error : undefined);
    }
  }
}

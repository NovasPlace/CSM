// PrimingEngine - Graph-like memory cascade
// Inspired by Agent Atlas CortexDB PrimingEngine
// Traverses linked memories to find related context

import { Database } from './database.js';
import {
  paramInColArray,
  parseArrayField,
  parseJsonField,
  toDate,
  type QueryDialect,
} from './db/query-dialect.js';
import { Memory } from './types.js';

export interface CascadeResult {
  memories: Memory[];
  depth: number;
  visited: Set<number>;
}

export class PrimingEngine {
  private database: Database;
  private maxDepth: number;
  private maxMemories: number;

  constructor(database: Database, maxDepth: number = 2, maxMemories: number = 20) {
    this.database = database;
    this.maxDepth = maxDepth;
    this.maxMemories = maxMemories;
  }

  /**
   * Cascade through linked memories starting from a seed memory
   * Returns a graph-like traversal of related memories
   */
  async cascade(memoryId: number): Promise<CascadeResult> {
    const visited = new Set<number>();
    const allMemories: Memory[] = [];

    await this.traverse(memoryId, 0, visited, allMemories);

    return {
      memories: allMemories.slice(0, this.maxMemories),
      depth: this.maxDepth,
      visited,
    };
  }

  /**
   * Cascade from multiple seed memories
   */
  async cascadeFromMultiple(memoryIds: number[]): Promise<CascadeResult> {
    const visited = new Set<number>();
    const allMemories: Memory[] = [];

    for (const memoryId of memoryIds) {
      await this.traverse(memoryId, 0, visited, allMemories);
    }

    // Sort by importance and recency
    allMemories.sort((a, b) => {
      const importanceDiff = b.importance - a.importance;
      if (importanceDiff !== 0) return importanceDiff;
      return b.accessedAt.getTime() - a.accessedAt.getTime();
    });

    return {
      memories: allMemories.slice(0, this.maxMemories),
      depth: this.maxDepth,
      visited,
    };
  }

  /**
   * Recursively traverse linked memories
   */
  private async traverse(
    memoryId: number,
    currentDepth: number,
    visited: Set<number>,
    allMemories: Memory[]
  ): Promise<void> {
    // Stop if max depth reached or already visited
    if (currentDepth > this.maxDepth || visited.has(memoryId)) {
      return;
    }

    // Stop if we have enough memories
    if (allMemories.length >= this.maxMemories) {
      return;
    }

    visited.add(memoryId);

    // Get the memory
    const memory = await this.getMemory(memoryId);
    if (!memory) {
      return;
    }

    // Add to results
    allMemories.push(memory);

    // Get linked memories
    const linkedIds = memory.linkedMemoryIds;
    if (!linkedIds || linkedIds.length === 0) {
      return;
    }

    // Recurse into linked memories
    for (const linkedId of linkedIds) {
      if (typeof linkedId === 'number') {
        await this.traverse(linkedId, currentDepth + 1, visited, allMemories);
      }
    }
  }

  /**
   * Get a single memory by ID
   */
  private async getMemory(id: number): Promise<Memory | null> {
    const pool = this.database.getPool();
    
    const result = await pool.query(
      'SELECT * FROM memories WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return mapMemoryRow(this.database.dialect, result.rows[0] as Record<string, unknown>);
  }

  /**
   * Find memories linked to a specific memory
   */
  async getLinkedMemories(memoryId: number): Promise<Memory[]> {
    const pool = this.database.getPool();
    
    const result = await pool.query(
      `SELECT * FROM memories 
       WHERE ${paramInColArray(this.database.dialect, 1, 'linked_memory_ids')}
       ORDER BY importance DESC, accessed_at DESC`,
      [memoryId]
    );

    return result.rows.map((row) =>
      mapMemoryRow(this.database.dialect, row as Record<string, unknown>),
    );
  }

  /**
   * Link two memories together (bidirectional)
   */
  async linkMemories(memoryId1: number, memoryId2: number): Promise<void> {
    if (this.database.dialect === 'sqlite') {
      await this.appendSqliteLink(memoryId1, memoryId2);
      await this.appendSqliteLink(memoryId2, memoryId1);
      return;
    }

    const pool = this.database.getPool();
    
    // Add memoryId2 to memoryId1's linked_memory_ids
    await pool.query(
      `UPDATE memories 
       SET linked_memory_ids = array_append(linked_memory_ids, $1)
       WHERE id = $2 AND NOT (${paramInColArray(this.database.dialect, 1, 'linked_memory_ids')})`,
      [memoryId2, memoryId1]
    );

    // Add memoryId1 to memoryId2's linked_memory_ids
    await pool.query(
      `UPDATE memories 
       SET linked_memory_ids = array_append(linked_memory_ids, $1)
       WHERE id = $2 AND NOT (${paramInColArray(this.database.dialect, 1, 'linked_memory_ids')})`,
      [memoryId1, memoryId2]
    );
  }

  /**
   * Unlink two memories (bidirectional)
   */
  async unlinkMemories(memoryId1: number, memoryId2: number): Promise<void> {
    if (this.database.dialect === 'sqlite') {
      await this.removeSqliteLink(memoryId1, memoryId2);
      await this.removeSqliteLink(memoryId2, memoryId1);
      return;
    }

    const pool = this.database.getPool();
    
    // Remove memoryId2 from memoryId1's linked_memory_ids
    await pool.query(
      `UPDATE memories 
       SET linked_memory_ids = array_remove(linked_memory_ids, $1)
       WHERE id = $2`,
      [memoryId2, memoryId1]
    );

    // Remove memoryId1 from memoryId2's linked_memory_ids
    await pool.query(
      `UPDATE memories 
       SET linked_memory_ids = array_remove(linked_memory_ids, $1)
       WHERE id = $2`,
      [memoryId1, memoryId2]
    );
  }

  private async appendSqliteLink(memoryId: number, linkedId: number): Promise<void> {
    await this.database.getPool().query(
      `UPDATE memories
       SET linked_memory_ids = json_insert(COALESCE(linked_memory_ids, '[]'), '$[#]', $1)
       WHERE id = $2
         AND NOT (${paramInColArray('sqlite', 1, 'linked_memory_ids')})`,
      [linkedId, memoryId],
    );
  }

  private async removeSqliteLink(memoryId: number, linkedId: number): Promise<void> {
    await this.database.getPool().query(
      `UPDATE memories
       SET linked_memory_ids = COALESCE(
         (SELECT json_group_array(value)
          FROM json_each(linked_memory_ids)
          WHERE value != $1),
         '[]'
       )
       WHERE id = $2`,
      [linkedId, memoryId],
    );
  }
}

function mapMemoryRow(dialect: QueryDialect, row: Record<string, unknown>): Memory {
  const tags = parseArrayField(dialect, row.tags)
    .filter((tag): tag is string => typeof tag === 'string');
  const linkedMemoryIds = parseArrayField(dialect, row.linked_memory_ids)
    .map(Number)
    .filter(Number.isFinite);
  return {
    id: row.id as number,
    sessionId: row.session_id as string | undefined,
    projectId: row.project_id as string | undefined,
    memoryType: row.memory_type as Memory['memoryType'],
    content: row.content as string,
    importance: row.importance as number,
    emotion: row.emotion as Memory['emotion'],
    confidence: row.confidence as number,
    source: row.source as Memory['source'],
    tags,
    linkedMemoryIds,
    metadata: parseJsonField(dialect, row.metadata),
    createdAt: toDate(dialect, row.created_at),
    updatedAt: toDate(dialect, row.updated_at),
    accessedAt: toDate(dialect, row.accessed_at),
    accessCount: row.access_count as number,
  };
}

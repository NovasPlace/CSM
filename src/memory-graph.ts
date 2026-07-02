import { Database } from "./database.js";
import type { ExtractedConcept } from "./concept-extractor.js";
import type { Memory } from "./types.js";
import { getLogger } from "./logger.js";
import { jsonExtractValue } from "./db/query-dialect.js";

export type MemoryLink = {
  id: number;
  source_id: number;
  target_id: number;
  link_type: "shared_entity" | "causal" | "temporal" | "reference";
  shared_entities: string[];
  strength: number;
  created_at: Date;
};

export type RelatedMemory = {
  memory: Memory;
  link: MemoryLink;
};

export async function initializeGraphSchema(db: Database): Promise<void> {
  const pool = db.getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_links (
      id SERIAL PRIMARY KEY,
      source_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      target_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      link_type TEXT NOT NULL CHECK (link_type IN ('shared_entity', 'causal', 'temporal', 'reference')),
      shared_entities JSONB NOT NULL DEFAULT '[]',
      strength REAL NOT NULL DEFAULT 0.5,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(source_id, target_id, link_type)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_links_source ON memory_links(source_id);
    CREATE INDEX IF NOT EXISTS idx_memory_links_target ON memory_links(target_id);
    CREATE INDEX IF NOT EXISTS idx_memory_links_type ON memory_links(link_type);
  `);
}

export function inferLinkType(
  sourceContent: string,
  targetContent: string,
  sourceDate: Date,
  targetDate: Date,
  shared: ExtractedConcept[]
): "shared_entity" | "causal" | "temporal" | "reference" {
  const hasFileOverlap = shared.some(c => c.type === "file");
  const hasFunctionOverlap = shared.some(c => c.type === "function");
  const hasErrorOverlap = shared.some(c => c.type === "error");
  const hasDecisionOverlap = shared.some(c => c.type === "decision");

  if (hasErrorOverlap && hasFileOverlap) return "causal";
  if (hasDecisionOverlap) return "reference";
  if (hasFileOverlap || hasFunctionOverlap) return "shared_entity";

  const timeDiff = Math.abs(sourceDate.getTime() - targetDate.getTime());
  if (timeDiff < 60000) return "temporal";

  return "shared_entity";
}

export async function buildLinksForMemory(
  db: Database,
  memoryId: number,
  concepts: ExtractedConcept[]
): Promise<MemoryLink[]> {
  if (concepts.length === 0) return [];

  const pool = db.getPool();
  const d = db.dialect;
  const entityValues = concepts.map(c => c.value);

  const memoryRows = await pool.query(
    `SELECT m.id, m.content, m.created_at, ${jsonExtractValue(d, 'm.metadata', 'extracted_concepts')} AS concepts
     FROM memories m
     WHERE m.id != $1
       AND ${jsonExtractValue(d, 'm.metadata', 'extracted_concepts')} IS NOT NULL
     ORDER BY m.created_at DESC
     LIMIT 50`,
    [memoryId]
  );

  const links: MemoryLink[] = [];

  for (const candidate of memoryRows.rows as any[]) {
    const candidateConcepts: any[] = candidate.concepts ?? [];
    const shared = entityValues.filter(v =>
      candidateConcepts.some((c: any) => c.value === v)
    );

    if (shared.length === 0) continue;

    const sourceRow = await pool.query(
      `SELECT content, created_at FROM memories WHERE id = $1`,
      [memoryId]
    );
    const sourceContent = (sourceRow.rows as any[])[0]?.content ?? "";
    const sourceDate = (sourceRow.rows as any[])[0]?.created_at ?? new Date();

    const linkType = inferLinkType(
      sourceContent,
      candidate.content,
      sourceDate,
      candidate.created_at,
      concepts.filter(c => shared.includes(c.value))
    );

    const strength = Math.min(shared.length / 5, 1.0);

    try {
      const result = await pool.query(
        `INSERT INTO memory_links (source_id, target_id, link_type, shared_entities, strength)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (source_id, target_id, link_type) DO UPDATE SET
           shared_entities = EXCLUDED.shared_entities,
           strength = EXCLUDED.strength
         RETURNING *`,
        [memoryId, candidate.id, linkType, JSON.stringify(shared), strength]
      );
      const row = (result.rows as any[])[0];
      if (row) {
        links.push({
          id: row.id,
          source_id: row.source_id,
          target_id: row.target_id,
          link_type: row.link_type,
          shared_entities: row.shared_entities,
          strength: row.strength,
          created_at: row.created_at,
        });
      }
     } catch (err) {
       getLogger().warn('Failed to create link');
     }
  }

  return links;
}

export async function getRelatedMemories(
  db: Database,
  memoryId: number,
  limit: number = 10
): Promise<RelatedMemory[]> {
  const pool = db.getPool();

  const linkRows = await pool.query(
    `SELECT ml.*, m.id AS mem_id, m.session_id, m.project_id, m.memory_type,
            m.content, m.importance, m.emotion, m.confidence, m.source,
            m.tags, m.linked_memory_ids, m.metadata,
            m.created_at AS mem_created, m.updated_at AS mem_updated,
            m.accessed_at, m.access_count
     FROM memory_links ml
     JOIN memories m ON m.id = ml.target_id
     WHERE ml.source_id = $1
     ORDER BY ml.strength DESC
     LIMIT $2`,
    [memoryId, limit]
  );

  return (linkRows.rows as any[]).map(row => ({
    memory: {
      id: row.mem_id,
      sessionId: row.session_id,
      projectId: row.project_id,
      memoryType: row.memory_type,
      content: row.content,
      importance: row.importance,
      emotion: row.emotion,
      confidence: row.confidence,
      source: row.source,
      tags: row.tags ?? [],
      linkedMemoryIds: row.linked_memory_ids ?? [],
      metadata: row.metadata ?? {},
      createdAt: row.mem_created,
      updatedAt: row.mem_updated,
      accessedAt: row.accessed_at,
      accessCount: row.access_count ?? 0,
    } as Memory,
    link: {
      id: row.id,
      source_id: row.source_id,
      target_id: row.target_id,
      link_type: row.link_type,
      shared_entities: row.shared_entities,
      strength: row.strength,
      created_at: row.created_at,
    } as MemoryLink,
  }));
}

export async function findSharedEntities(
  db: Database,
  memoryId: number
): Promise<ExtractedConcept[]> {
  const pool = db.getPool();
  const result = await pool.query(
    `SELECT DISTINCT jsonb_array_elements(ml.shared_entities) AS entity
     FROM memory_links ml
     WHERE ml.source_id = $1 OR ml.target_id = $1`,
    [memoryId]
  );

  return (result.rows as any[]).map(row => ({
    type: "concept" as const,
    value: row.entity,
    confidence: 1.0,
    source: "graph" as const,
  }));
}

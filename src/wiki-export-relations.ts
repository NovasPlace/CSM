import type { Memory } from './types.js';
import type { ExportedEntity, ExportedLink } from './wiki-note-renderer.js';
import type { WikiQueryClient } from './wiki-export-model.js';

const BATCH_SIZE = 1000;

export async function selectOneHopLinkedIds(
  client: WikiQueryClient,
  eligibleIds: Set<number>,
): Promise<number[]> {
  const ids = [...eligibleIds];
  const linkedIds = new Set<number>();
  for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
    const rows = await queryLinkedRows(client, ids.slice(offset, offset + BATCH_SIZE));
    for (const row of rows) linkedIds.add(Number(row.linked_id));
  }
  return [...linkedIds];
}

async function queryLinkedRows(
  client: WikiQueryClient,
  ids: number[],
): Promise<Array<{ linked_id: number }>> {
  const parameters = [...ids, ...ids, ...ids];
  const first = placeholders(ids.length, 0);
  const second = placeholders(ids.length, ids.length);
  const third = placeholders(ids.length, ids.length * 2);
  const result = await client.query(
    `SELECT DISTINCT CASE WHEN source_id IN (${first}) THEN target_id ELSE source_id END AS linked_id
     FROM memory_links WHERE source_id IN (${second}) OR target_id IN (${third})`,
    parameters,
  );
  return result.rows as Array<{ linked_id: number }>;
}

export async function selectLinks(
  client: WikiQueryClient,
  eligibleIds: Set<number>,
): Promise<Map<number, ExportedLink[]>> {
  const linkMap = new Map<number, ExportedLink[]>();
  const ids = [...eligibleIds];
  const seen = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
    const rows = await queryLinkRows(client, ids.slice(offset, offset + BATCH_SIZE));
    appendRows(linkMap, rows, eligibleIds, seen);
  }
  return linkMap;
}

interface LinkRow {
  source_id: number;
  target_id: number;
  link_type: string;
  strength: number;
  shared_entities: unknown;
}

async function queryLinkRows(client: WikiQueryClient, ids: number[]): Promise<LinkRow[]> {
  const first = placeholders(ids.length, 0);
  const second = placeholders(ids.length, ids.length);
  const result = await client.query(
    `SELECT source_id, target_id, link_type, strength, shared_entities
     FROM memory_links WHERE source_id IN (${first}) OR target_id IN (${second})
     ORDER BY link_type ASC, strength DESC, source_id ASC, target_id ASC`,
    [...ids, ...ids],
  );
  return result.rows as LinkRow[];
}

function appendRows(
  map: Map<number, ExportedLink[]>,
  rows: LinkRow[],
  eligibleIds: Set<number>,
  seen: Set<string>,
): void {
  for (const row of rows) {
    if (!eligibleIds.has(row.source_id) || !eligibleIds.has(row.target_id)) continue;
    const key = `${row.source_id}:${row.target_id}:${row.link_type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (eligibleIds.has(row.source_id)) appendLink(map, row.source_id, row.target_id, row, 'outgoing');
    if (eligibleIds.has(row.target_id)) appendLink(map, row.target_id, row.source_id, row, 'incoming');
  }
}

function appendLink(
  map: Map<number, ExportedLink[]>,
  memoryId: number,
  targetMemoryId: number,
  row: LinkRow,
  direction: ExportedLink['direction'],
): void {
  const links = map.get(memoryId) ?? [];
  links.push({
    targetMemoryId,
    linkType: row.link_type,
    strength: row.strength,
    direction,
    sharedEntities: parseArray(row.shared_entities),
  });
  map.set(memoryId, links);
}

export function extractEntities(memories: Memory[]): ExportedEntity[] {
  const map = new Map<string, ExportedEntity>();
  for (const memory of memories) appendMemoryEntities(map, memory);
  return [...map.values()].sort((a, b) =>
    b.referencedByMemoryIds.length - a.referencedByMemoryIds.length
      || a.conceptValue.localeCompare(b.conceptValue));
}

function appendMemoryEntities(map: Map<string, ExportedEntity>, memory: Memory): void {
  const concepts = (memory.metadata as Record<string, unknown>).extracted_concepts;
  if (!Array.isArray(concepts)) return;
  for (const raw of concepts) {
    const concept = raw as { type?: string; value?: string };
    if (!concept.type || !concept.value) continue;
    const key = `${concept.type}:${concept.value}`;
    const entity = map.get(key) ?? {
      conceptType: concept.type, conceptValue: concept.value, referencedByMemoryIds: [],
    };
    entity.referencedByMemoryIds.push(memory.id);
    map.set(key, entity);
  }
}

function placeholders(count: number, offset: number): string {
  return Array.from({ length: count }, (_, index) => `$${offset + index + 1}`).join(',');
}

function parseArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as string[] : [];
  } catch {
    return [];
  }
}

import { createHash } from 'node:crypto';
import type { QueryDialect } from './db/query-dialect.js';
import type { ExportSnapshot, SnapshotOptions, WikiDatabaseStats, WikiQueryClient } from './wiki-export-model.js';
import { selectMemories, selectMemoriesByIds } from './wiki-export-memory-query.js';
import { extractEntities, selectLinks, selectOneHopLinkedIds } from './wiki-export-relations.js';

export async function collectSnapshot(
  client: WikiQueryClient,
  dialect: QueryDialect,
  options: SnapshotOptions,
): Promise<ExportSnapshot> {
  const primary = await selectMemories(client, dialect, options);
  const eligibleIds = new Set(primary.map(memory => memory.id));
  const linked = await selectLinkedMemories(client, dialect, eligibleIds, options.includeLinked);
  for (const memory of linked) eligibleIds.add(memory.id);
  const memories = [...primary, ...linked];
  const links = await selectLinks(client, eligibleIds);
  const entities = extractEntities(memories);
  const sessionIds = new Set(memories.map(memory => memory.sessionId).filter(isString));
  const distilledSummaries = await selectDistilledSummaries(client, sessionIds);
  const stats = await computeDbStats(client, options.projectId);
  return { memories, links, entities, distilledSummaries, stats };
}

async function selectLinkedMemories(
  client: WikiQueryClient,
  dialect: QueryDialect,
  eligibleIds: Set<number>,
  includeLinked: boolean,
) {
  if (!includeLinked || eligibleIds.size === 0) return [];
  const linkedIds = await selectOneHopLinkedIds(client, eligibleIds);
  return selectMemoriesByIds(client, dialect, linkedIds.filter(id => !eligibleIds.has(id)));
}

async function selectDistilledSummaries(client: WikiQueryClient, sessionIds: Set<string>) {
  if (sessionIds.size === 0) return [];
  const ids = [...sessionIds];
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(',');
  const result = await client.query(
    `SELECT session_id, groups, built_at FROM distilled_summaries
     WHERE session_id IN (${placeholders}) ORDER BY built_at DESC`,
    ids,
  );
  return (result.rows as Array<{ session_id: string; groups: unknown; built_at: string }>).map(row => ({
    sessionId: row.session_id,
    groups: Array.isArray(row.groups) ? row.groups : [],
    builtAt: row.built_at,
  }));
}

async function computeDbStats(client: WikiQueryClient, projectId?: string): Promise<WikiDatabaseStats> {
  const filter = projectId ? 'WHERE project_id = $1' : '';
  const memory = await client.query(
    `SELECT COUNT(*)::text AS count, COALESCE(MAX(updated_at)::text, '') AS max_updated
     FROM memories ${filter}`,
    projectId ? [projectId] : [],
  );
  const links = await client.query(
    "SELECT COUNT(*)::text AS count, COALESCE(MAX(id)::text, '0') AS max_id FROM memory_links",
  );
  const distilled = await client.query(
    "SELECT COUNT(*)::text AS count, COALESCE(MAX(built_at)::text, '') AS max_updated FROM distilled_summaries",
  );
  return mapStats(memory.rows[0], links.rows[0], distilled.rows[0]);
}

function mapStats(memory: unknown, links: unknown, distilled: unknown): WikiDatabaseStats {
  const mem = memory as { count: string; max_updated: string };
  const link = links as { count: string; max_id: string };
  const summary = distilled as { count: string; max_updated: string };
  return {
    memoryCount: Number.parseInt(mem.count, 10) || 0,
    memoryMaxUpdatedAt: mem.max_updated || '',
    linkCount: Number.parseInt(link.count, 10) || 0,
    linkMaxId: Number.parseInt(link.max_id, 10) || 0,
    distilledCount: Number.parseInt(summary.count, 10) || 0,
    distilledMaxUpdatedAt: summary.max_updated || '',
  };
}

export function computeDatabaseFingerprint(snapshot: ExportSnapshot): string {
  return createHash('sha256').update(Object.values(snapshot.stats).join('|')).digest('hex');
}

function isString(value: string | undefined): value is string { return Boolean(value); }

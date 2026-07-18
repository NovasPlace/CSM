import type { Memory, MemoryType } from './types.js';
import { renderFrontmatter } from './wiki-yaml-frontmatter.js';
import { entityFilename, memoryFilename, memoryWikilink } from './wiki-slug.js';

export interface ExportedLink {
  targetMemoryId: number;
  linkType: string;
  strength: number;
  direction: 'outgoing' | 'incoming';
  sharedEntities?: string[];
}

export interface ExportedEntity {
  conceptType: string;
  conceptValue: string;
  referencedByMemoryIds: number[];
}

export interface RenderedNote { path: string; content: string }
export type NoteCategory = 'lessons' | 'decisions' | 'knowledge' | 'memories' | 'entities' | 'synthesis';

export function smartTitle(memory: Pick<Memory, 'id' | 'content'>): string {
  const content = memory.content.trim();
  if (!content) return `Memory ${memory.id}`;
  const heading = content.match(/^#\s+([^\n]+)/);
  if (heading) return truncateTitle(heading[1].trim());
  const stripped = content.replace(/^\[[^\]]+\]\s*/i, '');
  const firstLine = stripped.split('\n')[0].trim();
  return firstLine ? truncateTitle(firstLine) : `Memory ${memory.id}`;
}

function truncateTitle(value: string, maxLength = 80): string {
  if (value.length <= maxLength) return value;
  const prefix = value.slice(0, maxLength);
  const space = prefix.lastIndexOf(' ');
  return `${space > maxLength * 0.6 ? prefix.slice(0, space) : prefix}…`;
}

export function categoryForMemory(
  memory: Pick<Memory, 'memoryType' | 'metadata' | 'importance'>,
  importanceThreshold: number,
  _isLinkedInclusion: boolean,
): NoteCategory {
  const metadata = memory.metadata as Record<string, unknown>;
  if (metadata.promotion_source === 'belief_promotion_engine') return 'knowledge';
  if (memory.memoryType === 'preference' && metadata.source_kind === 'decision') return 'decisions';
  if (memory.memoryType === 'lesson' || memory.memoryType === 'procedural') return 'lessons';
  if ((memory.memoryType === 'workspace' || memory.memoryType === 'repo')
      && memory.importance >= importanceThreshold) return 'knowledge';
  return 'memories';
}

type NoteMemory = Pick<Memory,
  'id' | 'memoryType' | 'projectId' | 'sessionId' | 'content' | 'importance'
  | 'confidence' | 'createdAt' | 'updatedAt' | 'tags' | 'metadata'>;

export function renderMemoryNote(
  memory: NoteMemory,
  links: ExportedLink[],
  exportedMemoryIds: Set<number>,
  importanceThreshold: number,
  isLinkedInclusion: boolean,
): RenderedNote {
  const category = categoryForMemory(memory, importanceThreshold, isLinkedInclusion);
  const frontmatter = renderFrontmatter({
    csm_id: memory.id,
    type: memory.memoryType,
    project_id: memory.projectId ?? null,
    session_id: memory.sessionId ?? null,
    importance: round(memory.importance, 4),
    confidence: round(memory.confidence, 4),
    created_at: memory.createdAt.toISOString(),
    updated_at: memory.updatedAt.toISOString(),
    tags: memory.tags,
  });
  const body = [`# ${smartTitle(memory)}`, '', memory.content, '', renderRelationships(links, exportedMemoryIds)];
  return {
    path: `${category}/${memoryFilename(memory.id)}`,
    content: `${frontmatter}\n\n${body.join('\n')}\n`,
  };
}

function renderRelationships(links: ExportedLink[], exportedIds: Set<number>): string {
  const outgoing = sortLinks(links.filter(link => link.direction === 'outgoing'));
  const incoming = sortLinks(links.filter(link => link.direction === 'incoming'));
  if (outgoing.length === 0 && incoming.length === 0) return '';
  const sections = ['## Relationships'];
  appendLinkSection(sections, '### Outgoing', outgoing, exportedIds);
  appendLinkSection(sections, '### Backlinks', incoming, exportedIds);
  return sections.join('\n');
}

function appendLinkSection(
  sections: string[],
  title: string,
  links: ExportedLink[],
  exportedIds: Set<number>,
): void {
  if (links.length === 0) return;
  sections.push(title, ...links.map(link => formatLinkLine(link, exportedIds)));
}

function sortLinks(links: ExportedLink[]): ExportedLink[] {
  return links.sort((a, b) => a.linkType.localeCompare(b.linkType) || b.strength - a.strength);
}

function formatLinkLine(link: ExportedLink, exportedIds: Set<number>): string {
  const target = exportedIds.has(link.targetMemoryId)
    ? `[[${memoryWikilink(link.targetMemoryId)}]]`
    : `mem-${link.targetMemoryId} (not exported)`;
  const entities = link.sharedEntities?.length
    ? ` — entities: ${link.sharedEntities.slice(0, 3).join(', ')}`
    : '';
  return `- ${target} — ${link.linkType} (strength: ${round(link.strength, 2)})${entities}`;
}

export function renderEntityNote(entity: ExportedEntity): RenderedNote {
  const frontmatter = renderFrontmatter({
    concept_type: entity.conceptType,
    concept_value: entity.conceptValue,
    referenced_by_count: entity.referencedByMemoryIds.length,
  });
  const references = [...entity.referencedByMemoryIds]
    .sort((a, b) => a - b)
    .map(id => `- [[${memoryWikilink(id)}]]`);
  const body = [`# ${entity.conceptValue}`, '', '## Referenced by', ...references];
  return { path: `entities/${entityFilename(entity.conceptValue)}`, content: `${frontmatter}\n\n${body.join('\n')}\n` };
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function memoryTypeLabel(type: MemoryType): string { return type; }

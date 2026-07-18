import type { Memory } from './types.js';
import { memoryWikilink } from './wiki-slug.js';
import { smartTitle, type RenderedNote } from './wiki-memory-note-renderer.js';

export interface IndexPageData {
  totalNotes: number;
  byCategory: Record<string, number>;
  byType: Record<string, number>;
  recentLessons: Array<Pick<Memory, 'id' | 'content' | 'importance' | 'createdAt'>>;
  recentDecisions: Array<Pick<Memory, 'id' | 'content' | 'createdAt'>>;
  recentKnowledge: Array<Pick<Memory, 'id' | 'content' | 'importance' | 'createdAt'>>;
  entityHotlist: Array<{ conceptValue: string; refCount: number }>;
}

export function renderIndexPage(data: IndexPageData): RenderedNote {
  const lines = ['# Wiki Index', '', '## Statistics', `- Total notes: ${data.totalNotes}`];
  const categories = Object.entries(data.byCategory).sort((a, b) => a[0].localeCompare(b[0]));
  lines.push(...categories.map(([name, count]) => `- ${name}: ${count}`));
  lines.push('', '## By Memory Type');
  const types = Object.entries(data.byType).sort((a, b) => b[1] - a[1]);
  lines.push(...types.map(([name, count]) => `- ${name}: ${count}`));
  appendRecent(lines, '## Recent Lessons', data.recentLessons, true);
  appendRecent(lines, '## Recent Decisions', data.recentDecisions, false);
  appendRecent(lines, '## Recent Knowledge', data.recentKnowledge, true);
  lines.push('', '## Entity Hotlist');
  lines.push(...data.entityHotlist.map(item => `- ${item.conceptValue} (${item.refCount} references)`));
  return { path: 'index.md', content: `${lines.join('\n')}\n` };
}

function appendRecent(
  lines: string[],
  heading: string,
  memories: Array<Pick<Memory, 'id' | 'content' | 'createdAt'> & { importance?: number }>,
  showImportance: boolean,
): void {
  lines.push('', heading);
  for (const memory of memories) {
    const importance = showImportance ? ` (importance: ${round(memory.importance ?? 0, 2)})` : '';
    lines.push(`- [[${memoryWikilink(memory.id)}]]${importance} — ${smartTitle(memory)}`);
  }
}

export interface LogEntry {
  timestamp: string;
  mode: string;
  notesCreated: number;
  notesUpdated: number;
  notesRemoved: number;
  notesUnchanged: number;
  totalEligible: number;
}

export function renderLogEntry(entry: LogEntry): string {
  return [
    `## ${entry.timestamp}`,
    `- Mode: ${entry.mode}`,
    `- Eligible: ${entry.totalEligible}`,
    `- Created: ${entry.notesCreated}`,
    `- Updated: ${entry.notesUpdated}`,
    `- Removed: ${entry.notesRemoved}`,
    `- Unchanged: ${entry.notesUnchanged}`,
  ].join('\n');
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

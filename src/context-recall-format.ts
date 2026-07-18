import type { Memory, ToolCallGroup } from './types.js';

export function formatContextBrief(
  episodic: Memory[],
  procedural: Memory[],
  semantic: Memory[],
  distilled: ToolCallGroup[],
): string {
  const lines = ['=== CROSS-SESSION MEMORY CONTEXT ===', ''];
  appendDistilled(lines, distilled);
  appendMemories(lines, 'Recent Events (Episodic)', episodic, (memory) => memory.source);
  appendMemories(lines, 'Lessons Learned (Procedural)', procedural, (memory) => memory.emotion);
  appendMemories(lines, 'Project Context (Semantic)', semantic, (memory) => memory.memoryType);
  return lines.slice(0, 50).join('\n');
}

function appendDistilled(lines: string[], groups: ToolCallGroup[]): void {
  if (groups.length === 0) return;
  lines.push('## Recent Tool Activity (Distilled)');
  for (const group of groups.slice(0, 6)) {
    lines.push(`- [${outcomeLabel(group.outcome)}] ${formatGroup(group)}`);
  }
  lines.push('');
}

function appendMemories(
  lines: string[],
  heading: string,
  memories: Memory[],
  label: (memory: Memory) => string,
): void {
  if (memories.length === 0) return;
  lines.push(`## ${heading}`);
  for (const memory of memories.slice(0, 4)) {
    const preview = memory.content.substring(0, 80).replace(/\n/g, ' ');
    lines.push(`- [${label(memory)}] ${preview}${memory.content.length > 80 ? '...' : ''}`);
  }
  lines.push('');
}

function formatGroup(group: ToolCallGroup): string {
  const detail = group.outcome === 'success' && group.filesChanged.length > 0
    ? group.intent
    : group.proceduralInsight ?? group.intent;
  const files = group.filesChanged.map(fileName).slice(0, 4);
  const suffix = files.length === 0
    ? ''
    : ` | files: ${files.join(', ')}${group.filesChanged.length > files.length ? ', ...' : ''}`;
  const max = Math.max(40, 120 - suffix.length);
  const normalized = detail.replace(/\n/g, ' ');
  return `${normalized.substring(0, max)}${normalized.length > max ? '...' : ''}${suffix}`;
}

function fileName(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}

function outcomeLabel(outcome: ToolCallGroup['outcome']): string {
  if (outcome === 'success') return 'OK';
  if (outcome === 'failure') return 'FAIL';
  if (outcome === 'partial') return 'PARTIAL';
  return '?';
}

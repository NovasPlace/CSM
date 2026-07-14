import { getLogger } from './logger.js';
import type { MemoryManager } from './memory-manager.js';
import type { DatabasePool } from './types.js';
import type { ContextInjectionItem } from './context-injection-contract.js';

export interface ReEntryLayerText {
  text: string;
  sources: string[];
  items?: ContextInjectionItem[];
}

export async function buildIdentityLayer(
  pool: DatabasePool,
  sessionId: string,
  projectId: string,
): Promise<ReEntryLayerText> {
  const sources = ['sessions', 'project_scopes'];
  const [sessionCount, lastActive] = await Promise.all([
    querySessionCount(pool, projectId),
    queryLastActive(pool, projectId),
  ]);
  const text = [
    '## Identity', `Project: ${projectId}`, `Session ID: ${sessionId}`,
    sessionCount > 0 ? `This is session #${sessionCount} for this project.` : 'New project.',
    lastActive ? `Last active: ${lastActive}` : '',
  ].filter(Boolean).join('\n');
  const items: ContextInjectionItem[] = [{
    layerName: 'identity', sourceKind: 'derived_state', sourceId: 'session_metadata',
    memoryId: null, position: 0, selectionRank: null, selectionScore: null,
    selectionReason: null, disposition: 'injected', provenanceGranularity: 'layer',
    charCount: text.length, metadata: { sessionCount, lastActive },
  }];
  return { text, sources, items };
}

export async function buildGoalsLayer(
  memoryManager: MemoryManager,
  projectId: string,
): Promise<ReEntryLayerText> {
  const sources = ['memories (episodic, tagged:goal)'];
  const memories = await memoryManager.listMemories({
    projectId, type: 'episodic', limit: 5, sortBy: 'important',
  });
  const goals = memories.filter((memory) => memory.tags.includes('goal')
    || memory.tags.includes('decision') || memory.tags.includes('milestone'));
  if (goals.length === 0) return { text: '## Active Goals\nNo active goals recorded.', sources, items: [] };
  const lines = memoryLines(goals, 120);
  const items: ContextInjectionItem[] = goals.map((memory, index) => ({
    layerName: 'goals', sourceKind: 'memory', sourceId: `memory:${memory.id}`,
    memoryId: memory.id, position: index, selectionRank: index,
    selectionScore: memory.importance, selectionReason: 'importance_rank',
    disposition: 'injected', provenanceGranularity: 'item',
    charCount: lines[index].length, metadata: { tags: memory.tags },
  }));
  return { text: `## Active Goals\n${lines.join('\n')}`, sources, items };
}

export async function buildWorkLayer(
  pool: DatabasePool,
  memoryManager: MemoryManager,
  sessionId: string,
  projectId: string,
): Promise<ReEntryLayerText> {
  const sources = ['agent_work_journal', 'memories (procedural)'];
  const entries = await queryWorkEntries(pool, sessionId, projectId);
  if (entries.length === 0) return proceduralFallback(memoryManager, projectId, sources);
  const lines = entries.map((entry) => {
    const parts = [entry.intent.substring(0, 100)];
    if (entry.files.length > 0) parts.push(`(files: ${entry.files.slice(0, 3).join(', ')})`);
    return `- ${parts.join(' ')}`;
  });
  const text = `## In-Progress Work\n${lines.join('\n')}`;
  const items: ContextInjectionItem[] = [{
    layerName: 'work', sourceKind: 'derived_state', sourceId: 'agent_work_journal',
    memoryId: null, position: 0, selectionRank: null, selectionScore: null,
    selectionReason: 'recent_session', disposition: 'injected',
    provenanceGranularity: 'layer', charCount: text.length,
    metadata: { entryCount: entries.length },
  }];
  return { text, sources, items };
}

export async function buildPreferencesLayer(
  memoryManager: MemoryManager,
  projectId: string,
): Promise<ReEntryLayerText> {
  const sources = ['memories (preference)', 'belief_knowledge_store'];
  const memories = await memoryManager.listMemories({
    projectId, type: 'preference', limit: 5, sortBy: 'important',
  });
  const selected = memories.slice(0, 5);
  const lines = memoryLines(selected, 120);
  const text = lines.length > 0
    ? `## Preferences\n${lines.join('\n')}`
    : '## Preferences\nNo project-specific preferences recorded.';
  const items: ContextInjectionItem[] = selected.map((memory, index) => ({
    layerName: 'preferences', sourceKind: 'memory', sourceId: `memory:${memory.id}`,
    memoryId: memory.id, position: index, selectionRank: index,
    selectionScore: memory.importance, selectionReason: 'explicit_preference',
    disposition: 'injected', provenanceGranularity: 'item',
    charCount: lines[index]?.length ?? 0, metadata: {},
  }));
  return { text, sources, items };
}

async function querySessionCount(pool: DatabasePool, projectId: string): Promise<number> {
  try {
    const result = await pool.query('SELECT COUNT(*) as cnt FROM sessions WHERE project_id = $1',
      [projectId]);
    return Number((result.rows[0] as Record<string, unknown>)?.cnt ?? 0);
  } catch (error) {
    logDegradation('identity session count', error);
    return 0;
  }
}

async function queryLastActive(pool: DatabasePool, projectId: string): Promise<string> {
  try {
    const result = await pool.query(
      'SELECT updated_at FROM sessions WHERE project_id = $1 ORDER BY updated_at DESC LIMIT 1',
      [projectId],
    );
    return String((result.rows[0] as Record<string, unknown> | undefined)?.updated_at ?? '');
  } catch (error) {
    logDegradation('identity last-active', error);
    return '';
  }
}

async function queryWorkEntries(
  pool: DatabasePool,
  sessionId: string,
  projectId: string,
): Promise<Array<{ intent: string; files: string[] }>> {
  try {
    const result = await pool.query(
      `SELECT intent, files_touched FROM agent_work_journal
       WHERE project_id = $1 AND session_id != $2 ORDER BY created_at DESC, id DESC LIMIT $3`,
      [projectId, sessionId, 8],
    );
    return (result.rows as Record<string, unknown>[]).map((row) => ({
      intent: String(row.intent ?? ''), files: parseFiles(row.files_touched),
    }));
  } catch (error) {
    logDegradation('work journal', error);
    return [];
  }
}

async function proceduralFallback(
  memoryManager: MemoryManager,
  projectId: string,
  sources: string[],
): Promise<ReEntryLayerText> {
  const memories = await memoryManager.listMemories({
    projectId, type: 'procedural', limit: 3, sortBy: 'recent',
  });
  const lines = memoryLines(memories, 120);
  const text = lines.length > 0
    ? `## In-Progress Work\n${lines.join('\n')}`
    : '## In-Progress Work\nNo recent work recorded.';
  const items: ContextInjectionItem[] = memories.map((memory, index) => ({
    layerName: 'work', sourceKind: 'memory', sourceId: `memory:${memory.id}`,
    memoryId: memory.id, position: index, selectionRank: index,
    selectionScore: memory.importance, selectionReason: 'recent_session',
    disposition: 'injected', provenanceGranularity: 'item',
    charCount: lines[index]?.length ?? 0, metadata: { fallback: 'procedural' },
  }));
  return { text, sources, items };
}

function memoryLines(memories: Array<{ content: string }>, limit: number): string[] {
  return memories.map((memory) =>
    `- ${memory.content.substring(0, limit)}${memory.content.length > limit ? '...' : ''}`);
}

function parseFiles(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; }
}

function logDegradation(layer: string, value: unknown): void {
  const error = value instanceof Error ? value : new Error(String(value));
  getLogger().error(`Re-entry ${layer} source unavailable`, error);
}

import type { MemoryManager } from './memory-manager.js';
import type { DatabasePool } from './types.js';
import type { LayerBuildResult, WorkEntry } from './reentry-layer-types.js';

export async function buildIdentityLayer(
  pool: DatabasePool,
  sessionId: string,
  projectId: string,
): Promise<LayerBuildResult> {
  const [sessionCount, lastActive] = await Promise.all([
    readSessionCount(pool, projectId),
    readLastActive(pool, projectId),
  ]);
  const text = [
    '## Identity',
    `Project: ${projectId}`,
    `Session ID: ${sessionId}`,
    sessionCount > 0 ? `This is session #${sessionCount} for this project.` : 'New project.',
    lastActive ? `Last active: ${lastActive}` : '',
  ].filter(Boolean).join('\n');
  return { text, sources: ['sessions', 'project_scopes'] };
}

export async function buildGoalsLayer(
  memoryManager: MemoryManager,
  projectId: string,
): Promise<LayerBuildResult> {
  const memories = await memoryManager.listMemories({
    projectId, type: 'episodic', limit: 5, sortBy: 'important',
  });
  const goals = memories.filter((memory) =>
    ['goal', 'decision', 'milestone'].some((tag) => memory.tags.includes(tag)));
  const lines = goals.slice(0, 5).map((memory) => preview(memory.content));
  const text = lines.length === 0
    ? '## Active Goals\nNo active goals recorded.'
    : `## Active Goals\n${lines.map(bullet).join('\n')}`;
  return { text, sources: ['memories (episodic, tagged:goal)'] };
}

export async function buildWorkLayer(
  pool: DatabasePool,
  memoryManager: MemoryManager,
  sessionId: string,
  projectId: string,
): Promise<LayerBuildResult> {
  const sources = ['agent_work_journal', 'memories (procedural)'];
  const entries = await readWorkEntries(pool, sessionId, projectId);
  if (entries.length > 0) {
    return { text: `## In-Progress Work\n${entries.map(formatWorkEntry).join('\n')}`, sources };
  }
  const memories = await memoryManager.listMemories({
    projectId, type: 'procedural', limit: 3, sortBy: 'recent',
  });
  const text = memories.length === 0
    ? '## In-Progress Work\nNo recent work recorded.'
    : `## In-Progress Work\n${memories.map((memory) => bullet(preview(memory.content))).join('\n')}`;
  return { text, sources };
}

export async function buildPreferencesLayer(
  memoryManager: MemoryManager,
  projectId: string,
): Promise<LayerBuildResult> {
  const memories = await memoryManager.listMemories({
    projectId, type: 'preference', limit: 5, sortBy: 'important',
  });
  const lines = memories.slice(0, 5).map((memory) => bullet(preview(memory.content)));
  const text = lines.length === 0
    ? '## Preferences\nNo project-specific preferences recorded.'
    : `## Preferences\n${lines.join('\n')}`;
  return { text, sources: ['memories (preference)', 'belief_knowledge_store'] };
}

async function readSessionCount(pool: DatabasePool, projectId: string): Promise<number> {
  try {
    const result = await pool.query('SELECT COUNT(*) as cnt FROM sessions WHERE project_id = $1', [projectId]);
    return Number((result.rows[0] as { cnt?: unknown } | undefined)?.cnt ?? 0);
  } catch {
    return 0;
  }
}

async function readLastActive(pool: DatabasePool, projectId: string): Promise<string> {
  try {
    const result = await pool.query(
      'SELECT updated_at FROM sessions WHERE project_id = $1 ORDER BY updated_at DESC LIMIT 1',
      [projectId],
    );
    return String((result.rows[0] as { updated_at?: unknown } | undefined)?.updated_at ?? '');
  } catch {
    return '';
  }
}

async function readWorkEntries(
  pool: DatabasePool,
  sessionId: string,
  projectId: string,
): Promise<WorkEntry[]> {
  try {
    const result = await pool.query(
      `SELECT intent, files_touched FROM agent_work_journal
       WHERE (project_id = $1 OR project_id LIKE $2) AND session_id != $3
       ORDER BY created_at DESC LIMIT $4`,
      [projectId, `%${projectId.split(/[\\/]/).pop() ?? projectId}%`, sessionId, 8],
    );
    return (result.rows as Record<string, unknown>[]).map((row) => ({
      intent: String(row.intent ?? ''),
      filesTouched: Array.isArray(row.files_touched) ? row.files_touched as string[] : [],
    }));
  } catch {
    return [];
  }
}

function formatWorkEntry(entry: WorkEntry): string {
  const files = entry.filesTouched.length > 0
    ? ` (files: ${entry.filesTouched.slice(0, 3).join(', ')})`
    : '';
  return `- ${entry.intent.substring(0, 100)}${files}`;
}

function preview(content: string): string {
  return `${content.substring(0, 120)}${content.length > 120 ? '...' : ''}`;
}

function bullet(content: string): string {
  return `- ${content}`;
}

import type { ContextBrief, DatabasePool, Memory, ToolCallGroup } from './types.js';

export async function readCachedBrief(
  pool: DatabasePool,
  sessionId: string,
): Promise<ContextBrief | null> {
  const result = await pool.query(
    `SELECT * FROM session_contexts
     WHERE session_id = $1 AND expires_at > now()
     ORDER BY built_at DESC LIMIT 1`,
    [sessionId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    episodic: row.episodic_memories as Memory[],
    procedural: row.procedural_memories as Memory[],
    semantic: row.semantic_memories as Memory[],
    compressed: String(row.context_brief ?? ''),
  };
}

export async function readDistilledGroups(
  pool: DatabasePool,
  sessionId: string | null,
): Promise<ToolCallGroup[]> {
  if (!sessionId) return [];
  const result = await pool.query(
    `SELECT groups FROM distilled_summaries
     WHERE session_id = $1 ORDER BY built_at DESC LIMIT 3`,
    [sessionId],
  );
  const groups: ToolCallGroup[] = [];
  for (const row of result.rows as Array<{ groups?: unknown }>) {
    if (Array.isArray(row.groups)) groups.push(...row.groups as ToolCallGroup[]);
  }
  return groups.slice(0, 10);
}

export async function persistBrief(
  pool: DatabasePool,
  sessionId: string,
  projectId: string | null,
  brief: ContextBrief,
): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (id, directory, title, project_id)
     VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
    [sessionId, projectId ?? process.cwd(), `Session ${new Date().toISOString()}`, projectId ?? 'global'],
  );
  await pool.query(
    `INSERT INTO session_contexts
     (session_id, context_brief, episodic_memories, procedural_memories, semantic_memories)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      sessionId,
      brief.compressed,
      JSON.stringify(brief.episodic),
      JSON.stringify(brief.procedural),
      JSON.stringify(brief.semantic),
    ],
  );
}

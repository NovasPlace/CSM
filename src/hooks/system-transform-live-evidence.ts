import type { PluginContext } from '../plugin-context.js';
import { parseArrayField } from '../db/query-dialect.js';
import { MemoryGovernance } from '../memory_governance.js';
import type { SystemTransformOutput } from './system-transform-live-types.js';
import { logSystemTransformTelemetry } from './system-transform-live-telemetry.js';

interface MemorySnapshotRow {
  id: number;
  content: string;
  memory_type: string;
  importance: number | null;
  created_at: string;
  session_id: string | null;
  tags: string[] | null;
}

interface RecentSessionRow {
  id: string;
  created_at: string;
  updated_at: string;
  mem_count: string | number;
}

interface LessonRow {
  id: number;
  content: string;
  importance: number | null;
  created_at: string;
  session_id: string | null;
}

interface CountRow {
  cnt: string | number;
}

interface MemoryEvidence {
  memorySnapshot: string[];
  sessionHistory: string[];
  lessons: string[];
  dbStatus: string;
  totalRecords: number;
}

async function fetchMemorySnapshot(
  ctx: PluginContext,
  limit: number,
): Promise<string[]> {
  const result = await ctx.database.getPool().query(
    `SELECT id, content, memory_type, importance, created_at, session_id, tags
     FROM memories
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit],
  );
  return (result.rows as MemorySnapshotRow[]).map((row) => {
    const preview = row.content?.substring(0, 180)?.replace(/\n/g, ' ') ?? '(empty)';
    const tagValues = parseArrayField(ctx.database.dialect, row.tags).map(String);
    const tags = tagValues.length ? ` tags=[${tagValues.join(',')}]` : '';
    const sess = row.session_id ? ` session=${row.session_id.slice(0, 8)}` : '';
    const suffix = row.content?.length > 180 ? '...' : '';
    return `  #${row.id} [${row.memory_type}] imp=${row.importance?.toFixed(2) ?? '?'}${tags}${sess} — ${preview}${suffix}`;
  });
}

async function fetchRecentSessions(
  ctx: PluginContext,
  limit: number,
): Promise<string[]> {
  const result = await ctx.database.getPool().query(
    `SELECT s.id, s.created_at, s.updated_at,
            (SELECT COUNT(*) FROM memories m WHERE m.session_id = s.id) as mem_count
     FROM sessions s
     ORDER BY s.updated_at DESC
     LIMIT $1`,
    [limit],
  );
  return (result.rows as RecentSessionRow[]).map((row) => (
    `  Session ${row.id.slice(0, 8)} — ${String(row.mem_count)} memories — updated ${new Date(row.updated_at).toLocaleString()}`
  ));
}

async function fetchLessons(
  ctx: PluginContext,
  limit: number,
): Promise<string[]> {
  const result = await ctx.database.getPool().query(
    `SELECT id, content, importance, created_at, session_id
     FROM memories
     WHERE memory_type = 'lesson'
     ORDER BY importance DESC, created_at DESC
     LIMIT $1`,
    [limit],
  );
  return (result.rows as LessonRow[]).map((row) => {
    const preview = row.content?.substring(0, 200)?.replace(/\n/g, ' ') ?? '(empty)';
    const session = row.session_id?.slice(0, 8) ?? '?';
    return `  #${row.id} imp=${row.importance?.toFixed(2) ?? '?'} session=${session} — ${preview}`;
  });
}

async function loadMemoryEvidence(ctx: PluginContext): Promise<MemoryEvidence> {
  let memorySnapshot: string[] = [];
  let sessionHistory: string[] = [];
  let lessons: string[] = [];
  let dbStatus = 'unknown';
  let totalRecords = 0;
  try {
    const pool = ctx.database.getPool();
    const countResult = await pool.query('SELECT COUNT(*) as cnt FROM memories');
    totalRecords = parseInt(
      String((countResult.rows[0] as CountRow)?.cnt ?? '0'),
      10,
    );
    dbStatus = 'connected';
    [memorySnapshot, sessionHistory, lessons] = await Promise.all([
      fetchMemorySnapshot(ctx, 4),
      fetchRecentSessions(ctx, 3),
      fetchLessons(ctx, 3),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dbStatus = `error: ${message}`;
  }
  return { memorySnapshot, sessionHistory, lessons, dbStatus, totalRecords };
}

function formatEvidenceBlock(evidence: MemoryEvidence): string {
  const { dbStatus, totalRecords, memorySnapshot, sessionHistory, lessons } = evidence;
  return `
[CROSS-SESSION MEMORY EVIDENCE]
- db: ${dbStatus} | records: ${totalRecords} | tools: csm_memory_save/search/list/context/lesson/distill/compact
${totalRecords > 0 ? `
RECENT: ${memorySnapshot.slice(0, 4).join(' | ')}
SESSIONS: ${sessionHistory.slice(0, 3).join(' | ')}
LESSONS: ${lessons.length > 0 ? lessons.slice(0, 3).join(' | ') : '(none)'}
VERDICT: Persistent memory operational. Do NOT claim you lack memory.` : 'Store is empty but live.'}
[/CROSS-SESSION MEMORY EVIDENCE]`.trim();
}

export async function injectDirectMemoryEvidence(
  ctx: PluginContext,
  output: SystemTransformOutput,
): Promise<void> {
  output.system.unshift(formatEvidenceBlock(await loadMemoryEvidence(ctx)));
}

export async function injectLessonTriggers(
  ctx: PluginContext,
  output: SystemTransformOutput,
): Promise<void> {
  try {
    await ctx.lessonTriggers.refresh();
    const lessonInjection = ctx.lessonTriggers.buildFullSystemInjection();
    if (lessonInjection) output.system.push(lessonInjection);
  } catch {
    // Lesson triggers are non-critical.
  }
}

export async function injectMemoryGovernance(
  ctx: PluginContext,
  output: SystemTransformOutput,
): Promise<void> {
  if (ctx.config.databaseProvider !== 'postgres') return;
  try {
    const governance = new MemoryGovernance(ctx.database.getPool());
    const result = await governance.evaluate();
    if (result.vetoes.length === 0) return;
    const injection = governance.buildVetoInjection(result.vetoes);
    if (!injection) return;
    output.system.push(injection);
    logSystemTransformTelemetry({
      governanceVetoesInjected: result.vetoes.length,
      governanceVetoIds: result.vetoes.map((veto) => veto.memoryId),
      governanceAccessed: result.accessed,
      governanceAccessLog: result.accessLog,
    });
  } catch {
    // Governance injection is non-critical.
  }
}


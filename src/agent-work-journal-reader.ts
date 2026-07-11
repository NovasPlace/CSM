import { getLogger } from './logger.js';
import { asError } from './agent-work-journal-format.js';
import type { DatabasePool } from './types.js';
import { collectAllFiles, inferNextStep } from './work-journal-types.js';
import type {
  ResumeEntry,
  ResumePayload,
  WorkJournalConfig,
  WorkJournalEntryType,
} from './work-journal-types.js';

interface WorkJournalRow {
  id: number;
  entry_type: string;
  tool_name: string | null;
  intent: string | null;
  target: string | null;
  result_summary: string | null;
  error_summary: string | null;
  files_touched: string[] | string;
  created_at: Date | string;
}

export class AgentWorkJournalReader {
  constructor(
    private readonly pool: DatabasePool,
    private readonly config: WorkJournalConfig,
  ) {}

  async buildResumePayload(
    sessionId: string,
    projectId: string | undefined,
    activeGoal?: string,
  ): Promise<ResumePayload | null> {
    try {
      const fromSessionId = await this.findPriorSession(sessionId, projectId);
      if (!fromSessionId) return null;
      const result = await this.pool.query(
        `SELECT * FROM agent_work_journal
         WHERE session_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
        [fromSessionId, this.config.maxResumeEntries],
      );
      if (result.rows.length === 0) return null;
      return await this.toPayload(
        result.rows as WorkJournalRow[], fromSessionId, projectId, activeGoal,
      );
    } catch (error) {
      getLogger().error('WorkJournal resume payload build failed', asError(error));
      return null;
    }
  }

  async getRecentEntries(sessionId: string, limit: number): Promise<ResumeEntry[]> {
    try {
      const result = await this.pool.query(
        `SELECT * FROM agent_work_journal
         WHERE session_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
        [sessionId, limit],
      );
      return (result.rows as WorkJournalRow[]).map(toResumeEntry);
    } catch (error) {
      getLogger().error('WorkJournal recent-entry query failed', asError(error), { sessionId });
      return [];
    }
  }

  private async findPriorSession(
    sessionId: string,
    projectId?: string,
  ): Promise<string | null> {
    const result = projectId
      ? await this.pool.query(
        `SELECT session_id, MAX(created_at) AS last_active_at, MAX(id) AS last_entry_id
         FROM agent_work_journal WHERE project_id = $1 AND session_id != $2
         GROUP BY session_id ORDER BY MAX(created_at) DESC, MAX(id) DESC LIMIT 1`,
        [projectId, sessionId],
      )
      : await this.pool.query(
        `SELECT session_id, MAX(created_at) AS last_active_at, MAX(id) AS last_entry_id
         FROM agent_work_journal WHERE session_id != $1
         GROUP BY session_id ORDER BY MAX(created_at) DESC, MAX(id) DESC LIMIT 1`,
        [sessionId],
      );
    return result.rows.length > 0 ? sessionIdFrom(result.rows[0]) : null;
  }

  private async toPayload(
    rows: WorkJournalRow[],
    fromSessionId: string,
    projectId?: string,
    activeGoal?: string,
  ): Promise<ResumePayload> {
    const entries = rows.map(toResumeEntry);
    const count = await this.pool.query(
      'SELECT COUNT(*) as cnt FROM agent_work_journal WHERE session_id = $1',
      [fromSessionId],
    );
    return {
      fromSessionId,
      fromProjectId: projectId,
      lastActiveAt: normalizeDate(rows[0]!.created_at),
      totalEntries: Number((count.rows[0] as { cnt: string }).cnt),
      entries,
      activeGoal,
      nextStepInferred: inferNextStep(entries),
      allFilesTouched: collectAllFiles(entries),
      tokenCount: tokenCount(entries),
    };
  }
}

function toResumeEntry(row: WorkJournalRow): ResumeEntry {
  return {
    entryType: row.entry_type as WorkJournalEntryType,
    toolName: row.tool_name ?? undefined,
    intent: row.intent ?? '',
    target: row.target ?? undefined,
    resultSummary: row.result_summary ?? undefined,
    errorSummary: row.error_summary ?? undefined,
    filesTouched: parseFilesTouched(row.files_touched),
    createdAt: normalizeDate(row.created_at),
  };
}

function tokenCount(entries: ResumeEntry[]): number {
  const chars = entries.reduce((sum, entry) => sum + entry.intent.length
    + (entry.resultSummary?.length ?? 0) + (entry.errorSummary?.length ?? 0), 0);
  return Math.ceil(chars / 4);
}

function sessionIdFrom(row: unknown): string {
  return (row as { session_id: string }).session_id;
}

function parseFilesTouched(value: string[] | string): string[] {
  if (Array.isArray(value)) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
      ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeDate(value: Date | string): Date {
  if (value instanceof Date) return value;
  const sqliteUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z` : value;
  const parsed = new Date(sqliteUtc);
  if (Number.isNaN(parsed.getTime())) throw new Error('Malformed WorkJournal created_at value');
  return parsed;
}

import { buildLastSteps } from './work-journal-last-steps.js';
import { cacheBridgeTurnSignal } from './context-cache-signals.js';
import { collectAllFiles, inferNextStep, type ResumeEntry, type WorkJournalEntryType } from './work-journal-types.js';
import type { DatabasePool } from './types.js';

export interface BridgeWorkJournalSummary {
  sourceSessionId: string;
  lastActiveAt: Date;
  totalEntries: number;
  nextStepInferred?: string;
  lastSteps: string[];
  recentErrors: string[];
  filesTouched: string[];
}

export async function loadWorkJournalSummary(
  pool: DatabasePool,
  input: { sessionId: string; projectId: string; limit?: number; preferCurrent?: boolean },
): Promise<BridgeWorkJournalSummary | null> {
  const sourceSessionId = await findRelevantSessionId(pool, input);
  if (!sourceSessionId) return null;
  const entries = await loadEntries(pool, sourceSessionId, input.limit ?? 8);
  if (entries.length === 0) return null;
  const totalEntries = await countEntries(pool, sourceSessionId);
  return {
    sourceSessionId,
    lastActiveAt: entries[0]!.createdAt,
    totalEntries,
    nextStepInferred: inferNextStep(entries),
    lastSteps: buildLastSteps(entries, 4),
    recentErrors: collectRecentErrors(entries),
    filesTouched: collectAllFiles(entries),
  };
}

export async function writeBridgeTurnJournal(
  pool: DatabasePool,
  input: { sessionId: string; projectId: string; role: 'user' | 'assistant' | 'system'; content: string; resultSummary: string },
): Promise<void> {
  await Promise.all([
    pool.query(
    `INSERT INTO agent_work_journal
     (session_id, project_id, entry_type, tool_name, intent, result_summary, files_touched)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.sessionId,
      input.projectId,
      'decision',
      'bridge_sync_turn',
      summarizeIntent(input.role, input.content),
      input.resultSummary,
      [],
    ],
    ),
    cacheBridgeTurnSignal(pool, input),
  ]);
}

async function findRelevantSessionId(
  pool: DatabasePool,
  input: { sessionId: string; projectId: string; preferCurrent?: boolean },
): Promise<string | null> {
  if (input.preferCurrent) {
    const current = await findCurrentSessionId(pool, input);
    if (current) return current;
  }
  const prior = await findPriorProjectSessionId(pool, input);
  if (prior) return prior;
  return findLatestForeignSessionId(pool, input.sessionId);
}

async function findCurrentSessionId(
  pool: DatabasePool,
  input: { sessionId: string; projectId: string },
): Promise<string | null> {
  const result = await pool.query(
    `SELECT session_id
     FROM agent_work_journal
     WHERE session_id = $1 AND project_id = $2
     LIMIT 1`,
    [input.sessionId, input.projectId],
  );
  return readSessionId(result.rows[0]);
}

async function findPriorProjectSessionId(
  pool: DatabasePool,
  input: { sessionId: string; projectId: string },
): Promise<string | null> {
  const result = await pool.query(
    `SELECT session_id
     FROM agent_work_journal
     WHERE project_id = $1 AND session_id != $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [input.projectId, input.sessionId],
  );
  return readSessionId(result.rows[0]);
}

async function findLatestForeignSessionId(
  pool: DatabasePool,
  sessionId: string,
): Promise<string | null> {
  const result = await pool.query(
    `SELECT session_id
     FROM agent_work_journal
     WHERE session_id != $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [sessionId],
  );
  return readSessionId(result.rows[0]);
}

async function loadEntries(
  pool: DatabasePool,
  sessionId: string,
  limit: number,
): Promise<ResumeEntry[]> {
  const result = await pool.query(
    `SELECT entry_type, tool_name, intent, target, result_summary, error_summary,
            files_touched, created_at
     FROM agent_work_journal
     WHERE session_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [sessionId, limit],
  );
  return result.rows.map(mapResumeEntry);
}

async function countEntries(pool: DatabasePool, sessionId: string): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*) AS cnt FROM agent_work_journal WHERE session_id = $1`,
    [sessionId],
  );
  return Number((result.rows[0] as { cnt?: string }).cnt ?? '0');
}

function mapResumeEntry(row: unknown): ResumeEntry {
  const value = row as Record<string, unknown>;
  return {
    entryType: String(value.entry_type) as WorkJournalEntryType,
    toolName: readText(value.tool_name),
    intent: readText(value.intent) ?? '',
    target: readText(value.target),
    resultSummary: readText(value.result_summary),
    errorSummary: readText(value.error_summary),
    filesTouched: Array.isArray(value.files_touched) ? (value.files_touched as string[]) : [],
    createdAt: value.created_at as Date,
  };
}

function collectRecentErrors(entries: ResumeEntry[]): string[] {
  return entries
    .filter((entry) => entry.errorSummary)
    .slice(0, 3)
    .map((entry) => entry.errorSummary!);
}

function summarizeIntent(role: 'user' | 'assistant' | 'system', content: string): string {
  const trimmed = content.replace(/\s+/g, ' ').trim();
  const preview = trimmed.length <= 180 ? trimmed : `${trimmed.slice(0, 180)}...`;
  return `[${role}] ${preview}`;
}

function readSessionId(row: unknown): string | null {
  const value = row as { session_id?: string } | undefined;
  return value?.session_id ?? null;
}

function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

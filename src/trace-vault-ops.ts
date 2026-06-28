import type { BridgeDeps } from './bridge-ops.js';
import type { MemoryManager } from './memory-manager.js';
import type { DatabasePool } from './types.js';
import type { TraceVaultCaptureInput } from './trace-vault-types.js';
import { captureTraceVault, loadTraceVaultEntries, seedTeacherTracesFromVault } from './trace-vault-store.js';
import type { ResumeEntry } from './work-journal-types.js';

export async function captureTraceVaultOp(
  deps: BridgeDeps,
  input: TraceVaultCaptureInput,
) {
  ensureDatabase(deps);
  const entries = await loadJournalEntries(deps.database!.getPool(), input.sessionId, input.projectId);
  return captureTraceVault(deps.database!.getPool(), input, entries);
}

export async function previewTraceVaultOp(
  deps: BridgeDeps,
  sessionId: string,
  limit = 5,
) {
  ensureDatabase(deps);
  return loadTraceVaultEntries(deps.database!.getPool(), sessionId, limit);
}

export async function seedTeacherTracesFromVaultOp(
  deps: BridgeDeps,
  memoryManager: MemoryManager,
  sessionId: string,
  limit = 5,
) {
  ensureDatabase(deps);
  return seedTeacherTracesFromVault(deps.database!.getPool(), memoryManager, sessionId, limit);
}

function ensureDatabase(deps: BridgeDeps): asserts deps is BridgeDeps & { database: NonNullable<BridgeDeps['database']> } {
  if (!deps.database) throw new Error('Database is required for trace vault operations');
}

async function loadJournalEntries(
  pool: DatabasePool,
  sessionId: string,
  projectId?: string,
): Promise<ResumeEntry[]> {
  const result = await pool.query(
    `SELECT intent, target, result_summary, error_summary, files_touched, entry_type, tool_name, created_at
     FROM agent_work_journal
     WHERE session_id = $1
       AND ($2::text IS NULL OR project_id = $2)
     ORDER BY created_at ASC`,
    [sessionId, projectId ?? null],
  );

  return (result.rows as Record<string, unknown>[]).map((row) => ({
    entryType: row.entry_type as ResumeEntry['entryType'],
    toolName: row.tool_name as string | undefined,
    intent: (row.intent as string) ?? '',
    target: row.target as string | undefined,
    resultSummary: row.result_summary as string | undefined,
    errorSummary: row.error_summary as string | undefined,
    filesTouched: Array.isArray(row.files_touched)
      ? row.files_touched.filter((value): value is string => typeof value === 'string')
      : [],
    createdAt: row.created_at as Date,
  }));
}

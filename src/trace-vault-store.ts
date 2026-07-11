import type { DatabasePool, MemorySaveOptions } from './types.js';
import type { MemoryManager } from './memory-manager.js';
import type { ResumeEntry } from './work-journal-types.js';
import type { TraceVaultCaptureInput, TraceVaultCaptureResult } from './trace-vault-types.js';
import { buildTraceVaultCapture, formatTraceVaultCapture } from './trace-vault-core.js';

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS trace_vault_entries (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT,
  source_label TEXT NOT NULL,
  raw_trace TEXT NOT NULL,
  condensed_trace TEXT NOT NULL,
  raw_tokens INTEGER NOT NULL,
  condensed_tokens INTEGER NOT NULL,
  cards JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS trace_vault_entries_session_idx ON trace_vault_entries(session_id);
CREATE INDEX IF NOT EXISTS trace_vault_entries_project_idx ON trace_vault_entries(project_id);
CREATE INDEX IF NOT EXISTS trace_vault_entries_created_idx ON trace_vault_entries(created_at DESC);
`;

export async function initializeTraceVaultSchema(pool: DatabasePool): Promise<void> {
  await pool.query(CREATE_SQL);
}

export async function captureTraceVault(
  pool: DatabasePool,
  input: TraceVaultCaptureInput,
  entries: ResumeEntry[],
): Promise<TraceVaultCaptureResult> {
  const capture = buildTraceVaultCapture(input, entries);
  const result = await pool.query(
    `INSERT INTO trace_vault_entries
     (session_id, project_id, source_label, raw_trace, condensed_trace, raw_tokens, condensed_tokens, cards, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, created_at`,
    [
      capture.sessionId,
      capture.projectId ?? null,
      capture.sourceLabel,
      capture.rawTrace,
      capture.condensedTrace,
      capture.rawTokens,
      capture.condensedTokens,
      JSON.stringify(capture.cards),
      JSON.stringify({ entriesCount: entries.length }),
    ],
  );
  const row = result.rows[0] as Record<string, unknown>;
  return { ...capture, id: Number(row.id), capturedAt: (row.created_at as Date).toISOString() };
}

export async function loadTraceVaultEntries(
  pool: DatabasePool,
  sessionId: string,
  limit = 5,
): Promise<TraceVaultCaptureResult[]> {
  const result = await pool.query(
    `SELECT * FROM trace_vault_entries
     WHERE session_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [sessionId, limit],
  );
  return result.rows.map((row) => mapRow(row as Record<string, unknown>));
}

export async function seedTeacherTracesFromVault(
  pool: DatabasePool,
  memoryManager: MemoryManager,
  sessionId: string,
  limit = 5,
): Promise<{ seeded: number; vault: TraceVaultCaptureResult[] }> {
  const vault = await loadTraceVaultEntries(pool, sessionId, limit);
  let seeded = 0;
  for (const entry of vault) {
    for (const card of entry.cards) {
      await memoryManager.saveMemory(cardToMemory(entry.sessionId, entry.projectId, card));
      seeded++;
    }
  }
  return { seeded, vault };
}

export function formatTraceVaultForInjection(capture: TraceVaultCaptureResult): string {
  return formatTraceVaultCapture(capture);
}

function mapRow(row: Record<string, unknown>): TraceVaultCaptureResult {
  const cardsValue = row.cards;
  let cards: TraceVaultCaptureResult['cards'];
  try {
    cards = typeof cardsValue === 'string'
      ? JSON.parse(cardsValue)
      : (cardsValue as TraceVaultCaptureResult['cards']);
  } catch {
    cards = [];
  }
  const createdAt = row.created_at instanceof Date
    ? row.created_at
    : new Date(String(row.created_at ?? Date.now()));
  return {
    id: row.id as number,
    sessionId: row.session_id as string,
    projectId: row.project_id as string | undefined,
    sourceLabel: row.source_label as string,
    rawTrace: row.raw_trace as string,
    condensedTrace: row.condensed_trace as string,
    rawTokens: row.raw_tokens as number,
    condensedTokens: row.condensed_tokens as number,
    cards,
    capturedAt: createdAt.toISOString(),
  };
}

function cardToMemory(sessionId: string, projectId: string | undefined, card: TraceVaultCaptureResult['cards'][number]): MemorySaveOptions {
  const tags = ['teacher-trace', 'vault-trace', 'repair-card', ...card.triggerTools.map((tool) => `tool:${tool}`)];
  for (const file of card.triggerFiles) tags.push(`file:${file}`);
  return {
    content: `${card.lesson}\nProblem: ${card.problem}\nFix: ${card.correction}`,
    type: 'lesson',
    importance: 0.85,
    emotion: 'frustration',
    confidence: 0.95,
    source: 'lesson',
    tags,
    metadata: {
      source: 'vault_trace',
      projectId,
      triggers: {
        tools: card.triggerTools,
        files: card.triggerFiles,
        args: card.triggerArgPatterns,
      },
    },
    sessionId,
  };
}

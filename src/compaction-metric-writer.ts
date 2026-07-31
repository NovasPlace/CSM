import type { DatabasePool } from './types.js';
import { getLogger } from './logger.js';

export type CompactionStatus = 'compressed' | 'skipped_under_budget' | 'failed';
export type CompactionClientKind = 'opencode' | 'codex' | 'unknown';
export type CompactionRuntimeKind = 'plugin' | 'native_hook' | 'mcp' | 'unknown';

export interface CompactionMetricInput {
  sessionId: string;
  projectId?: string;
  clientKind?: CompactionClientKind;
  runtimeKind?: CompactionRuntimeKind;
  totalToolParts: number;
  compactedParts: number;
  skippedParts: number;
  eligibleParts?: number;
  persistedParts?: number;
  beforeChars: number;
  afterChars: number;
  beforeTokens: number;
  afterTokens: number;
  tokensSaved: number;
  savedPercent: number;
  semanticSignalCountPreserved: number;
  contextBriefChars: number;
  discardMarkerPresent: number;
  status: CompactionStatus;
  failureStage?: string;
  failureCode?: string;
  failureMessage?: string;
  createdAt: string;
}

export async function writeCompactionMetric(
  pool: DatabasePool,
  row: CompactionMetricInput,
): Promise<void> {
  await pool.query(
    `INSERT INTO compaction_metrics (
      session_id, project_id, client_kind, runtime_kind,
      total_tool_parts, compacted_parts, skipped_parts, eligible_parts, persisted_parts,
      before_chars, after_chars, before_tokens, after_tokens,
      tokens_saved, saved_percent, semantic_signal_count_preserved,
      context_brief_chars, discard_marker_present, status,
      failure_stage, failure_code, failure_message, created_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
      $21, $22, $23
    )`,
    [
      row.sessionId,
      row.projectId ?? null,
      row.clientKind ?? 'unknown',
      row.runtimeKind ?? 'unknown',
      row.totalToolParts,
      row.compactedParts,
      row.skippedParts,
      row.eligibleParts ?? 0,
      row.persistedParts ?? 0,
      row.beforeChars,
      row.afterChars,
      row.beforeTokens,
      row.afterTokens,
      row.tokensSaved,
      row.savedPercent,
      row.semanticSignalCountPreserved,
      row.contextBriefChars,
      row.discardMarkerPresent,
      row.status,
      row.failureStage ?? null,
      row.failureCode ?? null,
      row.failureMessage ?? null,
      row.createdAt,
    ],
  );
}

export function persistCompactionTelemetry(
  pool: DatabasePool,
  row: CompactionMetricInput,
): void {
  void writeCompactionMetric(pool, row).catch((error) => {
    getLogger().warn(`Compaction telemetry persistence failed: ${String(error)}`);
  });
}

import type { DatabasePool } from './types.js';
import { getLogger } from './logger.js';

export type CompactionStatus = 'compressed' | 'skipped_under_budget' | 'failed';

export interface CompactionMetricInput {
  sessionId: string;
  totalToolParts: number;
  compactedParts: number;
  skippedParts: number;
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
  createdAt: string;
}

export async function writeCompactionMetric(
  pool: DatabasePool,
  row: CompactionMetricInput,
): Promise<void> {
  await pool.query(
    `INSERT INTO compaction_metrics (
      session_id, total_tool_parts, compacted_parts, skipped_parts,
      before_chars, after_chars, before_tokens, after_tokens,
      tokens_saved, saved_percent, semantic_signal_count_preserved,
      context_brief_chars, discard_marker_present, status, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      row.sessionId,
      row.totalToolParts,
      row.compactedParts,
      row.skippedParts,
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

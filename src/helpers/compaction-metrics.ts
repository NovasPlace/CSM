import type { Database } from '../database.js';
import type { CompactionResult } from '../types.js';

export type CompactionMetricStatus = 'compressed' | 'skipped_under_budget' | 'failed';

export async function recordCompactionMetric(
  database: Database,
  sessionId: string,
  result: CompactionResult,
  contextBriefChars: number,
  discardMarkerPresent: boolean,
  status: CompactionMetricStatus = 'compressed',
): Promise<void> {
  const pool = database.getPool();
  await pool.query(
    `INSERT INTO compaction_metrics (
      session_id, total_tool_parts, compacted_parts, skipped_parts,
      before_chars, after_chars, before_tokens, after_tokens, tokens_saved,
      saved_percent, semantic_signal_count_preserved, context_brief_chars,
      discard_marker_present, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      sessionId, result.totalToolParts, result.compactedParts, result.skippedParts,
      result.beforeChars, result.afterChars, result.beforeTokens, result.afterTokens,
      result.tokensSaved, result.savedPercent, result.semanticSignalCountPreserved,
      contextBriefChars, discardMarkerPresent, status,
    ],
  );
}

export function hasToolDiscardMarker(messages: { parts?: unknown[] }[]): boolean {
  for (const message of messages) {
    for (const item of message.parts ?? []) {
      const part = item as { type?: string; state?: { output?: string; error?: string } };
      if (part.type !== 'tool') continue;
      const output = part.state?.output ?? '';
      const error = part.state?.error ?? '';
      if (output.includes('[COMPACTED]') || error.includes('[COMPACTED]')) return true;
    }
  }
  return false;
}

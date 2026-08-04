/**
 * Auto-promote high-confidence memory candidates into durable lessons.
 *
 * Strict gates ensure only genuinely useful, cross-session knowledge gets
 * promoted — not file-change notifications, loop warnings, or tool-usage noise.
 *
 * Gates (all must pass):
 *   1. High recall      — ≥ minRecall recall events
 *   2. Cross-session     — recalled in ≥ minSessions distinct sessions
 *   3. Content quality   — passes isLessonWorthy() heuristic
 *   4. Dedup             — no existing lesson with the same content hash
 *
 * Promoted lessons are marked with metadata.auto_promoted = true so they can
 * be audited and reverted. The source candidate is marked 'applied'.
 */
import type { PluginContext } from './plugin-context.js';
import type { DatabasePool, LessonPromotionConfig } from './types.js';
import { getLogger } from './logger.js';
import { createHash } from 'node:crypto';

export interface LessonPromotionReport {
  evaluated: number;
  promoted: number;
  skipped: number;
  reasons: Record<string, number>;
  promotedMemoryIds: number[];
}

/** Noise patterns that should never become lessons. */
const NOISE_PATTERNS: RegExp[] = [
  /^\[modified\]/i,                        // file-change notifications
  /^\[written\]/i,
  /^\[edited\]/i,
  /^Tool used:/i,                          // tool-usage episodic
  /^Command executed:/i,
  /^File (written|edited):/i,
  /^Avoid repeating .* with identical arguments/i, // loop-detection lessons
  /^\[WS\]/i,                              // workspace snapshots
  /^\[REPO\]/i,
  /^\[git\]/i,
];

/** Minimum meaningful content length for a lesson. */
const MIN_LESSON_LENGTH = 40;

interface CandidateRow {
  id: string;
  memory_id: string;
  reason: string;
  confidence: number;
  content: string;
  memory_type: string;
  recall_count: string;
  session_count: string;
}

export function isLessonWorthy(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length < MIN_LESSON_LENGTH) return false;
  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(trimmed)) return false;
  }
  return true;
}

export async function autoPromoteLessons(
  ctx: PluginContext,
  config: LessonPromotionConfig,
): Promise<LessonPromotionReport> {
  const log = getLogger();
  const pool = ctx.database.getPool();

  if (!config.enabled) {
    return { evaluated: 0, promoted: 0, skipped: 0, reasons: {}, promotedMemoryIds: [] };
  }

  // Find pending promote_to_lesson candidates that meet recall + session thresholds.
  const result = await pool.query(`
    SELECT
      cq.id::text, cq.memory_id::text, cq.reason, cq.confidence,
      m.content, m.memory_type,
      COUNT(r.id)::text AS recall_count,
      COUNT(DISTINCT r.session_id)::text AS session_count
    FROM memory_candidate_queue cq
    JOIN memories m ON m.id = cq.memory_id::bigint
    LEFT JOIN memory_recall_events r ON r.memory_id = m.id
    WHERE cq.candidate_type = 'promote_to_lesson'
      AND cq.status = 'pending'
      AND m.superseded_by IS NULL
      AND m.archived_at IS NULL
    GROUP BY cq.id, cq.memory_id, cq.reason, cq.confidence, m.content, m.memory_type
    HAVING COUNT(r.id) >= $1 AND COUNT(DISTINCT r.session_id) >= $2
    ORDER BY COUNT(r.id) DESC
    LIMIT $3
  `, [config.minRecall, config.minSessions, config.maxPromotePerRun * 3]);

  const candidates = result.rows as CandidateRow[];
  const reasons: Record<string, number> = {};
  let promoted = 0;
  const promotedMemoryIds: number[] = [];

  for (const candidate of candidates) {
    // Gate 3: Content quality
    if (!isLessonWorthy(candidate.content)) {
      reasons['skipped_noise'] = (reasons['skipped_noise'] ?? 0) + 1;
      await markCandidateStatus(pool, candidate.id, 'dismissed');
      continue;
    }

    // Gate 4: Dedup — check if an identical lesson already exists
    const contentHash = hashContent(candidate.content);
    const existing = await pool.query(`
      SELECT id FROM memories
      WHERE memory_type = 'lesson'
        AND superseded_by IS NULL
        AND md5(content) = md5($1)
      LIMIT 1
    `, [candidate.content]);

    if ((existing.rows as unknown[]).length > 0) {
      reasons['skipped_duplicate'] = (reasons['skipped_duplicate'] ?? 0) + 1;
      await markCandidateStatus(pool, candidate.id, 'dismissed');
      continue;
    }

    if (promoted >= config.maxPromotePerRun) {
      reasons['skipped_cap'] = (reasons['skipped_cap'] ?? 0) + 1;
      continue;
    }

    // Promote: create a lesson memory from the source content
    const newMemory = await ctx.memoryManager.saveMemory({
      content: candidate.content,
      type: 'lesson',
      importance: 0.8,
      source: 'lesson',
      tags: ['auto-promoted', 'cross-session'],
      metadata: {
        autoPromoted: true,
        promotedFromMemoryId: candidate.memory_id,
        promotedFromCandidateId: candidate.id,
        recallCount: parseInt(candidate.recall_count, 10),
        sessionCount: parseInt(candidate.session_count, 10),
        originalType: candidate.memory_type,
        contentHash,
        promotedAt: new Date().toISOString(),
      },
      projectId: ctx.directory,
    });

    if (newMemory?.id) {
      promotedMemoryIds.push(newMemory.id);
      await markCandidateStatus(pool, candidate.id, 'applied');
      promoted++;
      log.info(
        `Auto-promoted lesson #${newMemory.id} from memory #${candidate.memory_id} `
        + `(recall=${candidate.recall_count}, sessions=${candidate.session_count})`,
      );
    }
  }

  const report: LessonPromotionReport = {
    evaluated: candidates.length,
    promoted,
    skipped: candidates.length - promoted,
    reasons,
    promotedMemoryIds,
  };
  log.info(
    `Lesson auto-promotion: ${promoted} promoted, ${report.skipped} skipped `
    + `from ${candidates.length} candidates`,
  );
  return report;
}

async function markCandidateStatus(
  pool: DatabasePool,
  candidateId: string,
  status: string,
): Promise<void> {
  await pool.query(
    `UPDATE memory_candidate_queue SET status = $1, updated_at = NOW() WHERE id = $2::bigint`,
    [status, candidateId],
  );
}

function hashContent(content: string): string {
  return createHash('md5').update(content.trim().toLowerCase()).digest('hex').slice(0, 16);
}

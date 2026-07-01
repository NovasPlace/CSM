// Phase 2D: Memory Quality Scoring
// Deterministic heuristic scoring for active memories
// Run: node scripts/quality-score-dryrun.mjs
// Apply: node scripts/quality-score-apply.mjs --apply

export interface QualitySignal {
  contentLength: number;
  hasTitle: boolean;
  hasSourceSession: boolean;
  hasProjectId: boolean;
  hasMemoryType: boolean;
  hasEmbedding: boolean;
  importance: number;
  confidence: number;
  recency: number;
  duplicateStatus: 'superseded' | 'active';
  retrievalCount: number;
}

export interface QualityScore {
  id: number;
  memoryId: number;
  memoryType: string;
  qualityScore: number;
  qualityReason: string;
  qualitySignals: QualitySignal;
  qualityScoredAt: Date;
}

/**
 * Scoring heuristics for memory quality.
 * Returns 0-1 score with detailed reasoning.
 */
export function scoreMemory(signals: QualitySignal): {
  score: number;
  reason: string;
  weightedSignals: {
    title: number;
    source: number;
    project: number;
    embedding: number;
    importance: number;
    confidence: number;
    recency: number;
    retrieval: number;
    length: number;
  };
} {
  const {
    contentLength,
    hasTitle,
    hasSourceSession,
    hasProjectId,
    hasMemoryType,
    hasEmbedding,
    importance,
    confidence,
    recency,
    duplicateStatus,
    retrievalCount,
  } = signals;

  // Disqualify superseded memories
  if (duplicateStatus === 'superseded') {
    return {
      score: 0,
      reason: 'Superseded memory (not scored)',
      weightedSignals: {
        title: 0,
        source: 0,
        project: 0,
        embedding: 0,
        importance: 0,
        confidence: 0,
        recency: 0,
        retrieval: 0,
        length: 0,
      },
    };
  }

  let score = 0;
  const reasons: string[] = [];

  // Title: +0.15 (titles help quick recall)
  const titleBonus = hasTitle ? 0.15 : 0;
  if (hasTitle) {
    reasons.push('has title');
  }

  // Source session: +0.1 (ties to specific session)
  const sourceBonus = hasSourceSession ? 0.1 : 0;
  if (hasSourceSession) {
    reasons.push('has source session');
  }

  // Project ID: +0.1 (project context)
  const projectBonus = hasProjectId ? 0.1 : 0;
  if (hasProjectId) {
    reasons.push('has project context');
  }

  // Memory type: +0.05 (type filterable)
  if (hasMemoryType) {
    reasons.push('has memory type');
  }

  // Embedding: +0.15 (enables semantic search)
  const embeddingBonus = hasEmbedding ? 0.15 : 0;
  if (hasEmbedding) {
    reasons.push('has embedding');
  }

  // Importance: +0.2 (importance 0-1)
  score += importance * 0.2;
  if (importance > 0.7) {
    reasons.push(`high importance (${importance.toFixed(2)})`);
  } else if (importance > 0.4) {
    reasons.push(`medium importance (${importance.toFixed(2)})`);
  }

  // Confidence: +0.15 (confidence 0-1)
  score += confidence * 0.15;
  if (confidence > 0.7) {
    reasons.push(`high confidence (${confidence.toFixed(2)})`);
  }

  // Recency: +0.1 (0-1, where 1 is today)
  score += recency * 0.1;

  // Retrieval count: +0.15 (0-1 normalized, capped at 0.3 bonus)
  const retrievalBonus = Math.min(retrievalCount / 10, 0.3);
  score += retrievalBonus;
  if (retrievalCount > 0) {
    reasons.push(`retrieved ${retrievalCount}x`);
  }

  // Content length: -0.1 if too short (< 20 chars), +0.05 if optimal (200-500)
  let lengthScore = 0;
  if (contentLength < 20) {
    lengthScore = -0.1;
    reasons.push('very short content');
  } else if (contentLength >= 200 && contentLength <= 500) {
    lengthScore = 0.05;
    reasons.push('optimal length');
  } else if (contentLength > 500) {
    lengthScore = 0.02;
    reasons.push('long content');
  }
  score += lengthScore;

  // Clamp to 0-1
  score = Math.max(0, Math.min(1, score));

  return {
    score,
    reason: reasons.length > 0 ? reasons.join(', ') : 'minimal signals',
    weightedSignals: {
      title: titleBonus,
      source: sourceBonus,
      project: projectBonus,
      embedding: embeddingBonus,
      importance: importance,
      confidence: confidence,
      recency: recency,
      retrieval: Math.min(retrievalCount / 10, 0.3),
      length: lengthScore,
    },
  };
}

/**
 * Categorize score into bands for easy reporting.
 */
export function getScoreBand(score: number): string {
  if (score >= 0.7) return 'high';
  if (score >= 0.4) return 'medium';
  if (score >= 0.2) return 'low';
  return 'very low';
}

/**
 * Generate summary statistics from scores.
 */
export function summarizeScores(scores: QualityScore[]) {
  const bands = scores.reduce(
    (acc, s) => {
      acc[s.qualityScore.toFixed(2)] = (acc[s.qualityScore.toFixed(2)] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const bandCounts = scores.reduce(
    (acc, s) => {
      acc[getScoreBand(s.qualityScore)] = (acc[getScoreBand(s.qualityScore)] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const avgScore = scores.reduce((sum, s) => sum + s.qualityScore, 0) / scores.length;
  const minScore = Math.min(...scores.map((s) => s.qualityScore));
  const maxScore = Math.max(...scores.map((s) => s.qualityScore));

  return {
    totalScores: scores.length,
    avgScore,
    minScore,
    maxScore,
    bandCounts,
    scoreDistribution: bands,
  };
}
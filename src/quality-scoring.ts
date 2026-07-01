// Phase 2D: Memory Quality Scoring
// Deterministic heuristic scoring for active memories

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

export interface QualityFeatures {
  title: number;
  source: number;
  project: number;
  memoryType: number;
  embedding: number;
  importance: number;
  confidence: number;
  recency: number;
  retrieval: number;
  length: number;
}

export interface QualityResult {
  score: number;
  band: QualityBand;
  features: QualityFeatures;
  scoringVersion: string;
}

export type QualityBand = 'high' | 'medium' | 'low' | 'very low';

export const QUALITY_SCORING_VERSION = 'phase2d-v1';

const TITLE_BONUS = 0.15;
const SOURCE_BONUS = 0.1;
const PROJECT_BONUS = 0.1;
const MEMORY_TYPE_BONUS = 0.05;
const EMBEDDING_BONUS = 0.15;
const IMPORTANCE_WEIGHT = 0.2;
const CONFIDENCE_WEIGHT = 0.15;
const RECENCY_WEIGHT = 0.1;
const RETRIEVAL_STEP = 0.015;
const RETRIEVAL_MAX = 0.15;

export function scoreMemory(signals: QualitySignal): QualityResult {
  if (signals.duplicateStatus === 'superseded') {
    return zeroScore();
  }

  const features = {
    title: signals.hasTitle ? TITLE_BONUS : 0,
    source: signals.hasSourceSession ? SOURCE_BONUS : 0,
    project: signals.hasProjectId ? PROJECT_BONUS : 0,
    memoryType: signals.hasMemoryType ? MEMORY_TYPE_BONUS : 0,
    embedding: signals.hasEmbedding ? EMBEDDING_BONUS : 0,
    importance: signals.importance * IMPORTANCE_WEIGHT,
    confidence: signals.confidence * CONFIDENCE_WEIGHT,
    recency: signals.recency * RECENCY_WEIGHT,
    retrieval: Math.min(signals.retrievalCount * RETRIEVAL_STEP, RETRIEVAL_MAX),
    length: lengthScore(signals.contentLength),
  };
  const score = clampScore(
    Object.values(features).reduce((sum, value) => sum + value, 0),
  );

  return {
    score,
    band: getScoreBand(score),
    features,
    scoringVersion: QUALITY_SCORING_VERSION,
  };
}

export function recencyScore(createdAt: string | Date, now = new Date()): number {
  const ageDays = (now.getTime() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays < 1) return 1;
  if (ageDays < 7) return 0.8;
  if (ageDays < 14) return 0.6;
  if (ageDays < 30) return 0.4;
  if (ageDays < 60) return 0.2;
  return 0.05;
}

export function getScoreBand(score: number): QualityBand {
  if (score >= 0.7) return 'high';
  if (score >= 0.4) return 'medium';
  if (score >= 0.2) return 'low';
  return 'very low';
}

export function summarizeScores(scores: Array<{ score: number; band: QualityBand }>) {
  if (scores.length === 0) {
    return {
      totalScores: 0,
      avgScore: 0,
      minScore: 0,
      maxScore: 0,
      bandCounts: {} as Record<QualityBand, number>,
      scoreDistribution: {} as Record<string, number>,
    };
  }

  const scoreDistribution = scores.reduce<Record<string, number>>((acc, item) => {
    const key = item.score.toFixed(2);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const bandCounts = scores.reduce<Record<QualityBand, number>>((acc, item) => {
    acc[item.band] = (acc[item.band] || 0) + 1;
    return acc;
  }, {} as Record<QualityBand, number>);

  return {
    totalScores: scores.length,
    avgScore: scores.reduce((sum, item) => sum + item.score, 0) / scores.length,
    minScore: Math.min(...scores.map((item) => item.score)),
    maxScore: Math.max(...scores.map((item) => item.score)),
    bandCounts,
    scoreDistribution,
  };
}

function zeroScore(): QualityResult {
  return {
    score: 0,
    band: 'very low',
    features: {
      title: 0,
      source: 0,
      project: 0,
      memoryType: 0,
      embedding: 0,
      importance: 0,
      confidence: 0,
      recency: 0,
      retrieval: 0,
      length: 0,
    },
    scoringVersion: QUALITY_SCORING_VERSION,
  };
}

function lengthScore(contentLength: number): number {
  if (contentLength < 20) return -0.1;
  if (contentLength <= 500 && contentLength >= 200) return 0.05;
  if (contentLength > 500) return 0.02;
  return 0;
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(1, score));
}

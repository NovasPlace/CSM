import type {
  CompactionQualityMetrics,
  CompactionQualityConfig,
} from "./types.js";
import { EmbeddingGenerator } from "./embeddings.js";
const ENTITY_PATTERNS = [
  /(?:src\/|lib\/|test\/|dist\/|pkg\/)[\w./\-]+\.\w+/g,
  /\b[A-Z][a-zA-Z0-9]+(?:Exception|Error|Warning)\b/g,
  /\b[a-z]+(?:[A-Z][a-zA-Z0-9]*)+\b/g,
  /\b[A-Z][a-z]+(?:[A-Z][a-zA-Z0-9]*)+\b/g,
  /\b(?:npm|pip|cargo|go|yarn|pnpm)\s+[\w\-@/]+\b/g,
  /`[^`]+`/g,
  /\b[A-Z_]{2,}\b/g,
  /\b\w+:\w+\b/g,
];
const DECISION_PATTERNS = [
  /(?:decided|decision|chose|chosen|opted|selected|prefer|should|must|will|shall)[:\s]+(?:to\s+)?[\w\s,]+/gi,
  /(?:because|since|as|given that|reason|rationale|justification)[:\s]+[\w\s,]+/gi,
  /(?:important|critical|essential|mandatory|required|necessary)[:\s]+[\w\s,]+/gi,
];
const WARNING_ERROR_PATTERNS = [
  /(?:error|warning|deprecated|rollback|breaking|security|vulnerability|unsafe|unsafe|critical|fail)[:\s]+[\w\s,.\-?!]+/gi,
  /(?:ERROR|WARN|FATAL|CRITICAL|DEPRECATED|BREAKING)[:\s]+[\w\s,.\-?!]+/gi,
  /(?:does not exist|constraint violation|permission denied|access denied|not found|unauthorized)/gi,
];
export function extractEntities(text: string): string[] {
  const entities = new Set<string>();
  for (const pattern of ENTITY_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      entities.add(match[0]);
    }
  }
  return Array.from(entities);
}
export function extractDecisions(text: string): string[] {
  const decisions = new Set<string>();
  for (const pattern of DECISION_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      decisions.add(match[0].trim().toLowerCase());
    }
  }
  return Array.from(decisions);
}
export function extractWarningsErrors(text: string): string[] {
  const warnings = new Set<string>();
  for (const pattern of WARNING_ERROR_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      warnings.add(match[0].trim().toLowerCase());
    }
  }
  return Array.from(warnings);
}
export function computeRetention(before: string[], after: string[]): number {
  if (before.length === 0) return 1.0;
  const afterSignals = after.map(normalizeSignal);
  const retained = before.filter((item) => signalRetained(normalizeSignal(item), afterSignals));
  return retained.length / before.length;
}
function normalizeSignal(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}
function signalRetained(before: string, afterSignals: string[]): boolean {
  return afterSignals.some((after) => {
    if (before === after) return true;
    if (before.startsWith(after) && tokenCount(after) >= 2) return true;
    return overlapRatio(before, after) >= 0.75 && tokenCount(after) >= 2;
  });
}
function overlapRatio(before: string, after: string): number {
  const beforeTokens = new Set(before.split(/\W+/).filter(Boolean));
  const afterTokens = new Set(after.split(/\W+/).filter(Boolean));
  if (beforeTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of beforeTokens) {
    if (afterTokens.has(token)) overlap++;
  }
  return overlap / beforeTokens.size;
}
function tokenCount(value: string): number {
  return value.split(/\W+/).filter(Boolean).length;
}
export function computeCompressionRatio(
  tokensBefore: number,
  tokensAfter: number,
): number {
  if (tokensBefore === 0) return 0;
  return 1 - tokensAfter / tokensBefore;
}
export function computeQualityScore(
  entityRetention: number,
  decisionRetention: number,
  warningErrorRetention: number,
  semanticSimilarity: number,
  config: CompactionQualityConfig,
): number {
  return (
    entityRetention * config.entityRetentionWeight +
    decisionRetention * config.decisionRetentionWeight +
    warningErrorRetention * config.warningErrorRetentionWeight +
    semanticSimilarity * config.semanticSimilarityWeight
  );
}
export async function measureCompactionQuality(
  textBefore: string,
  textAfter: string,
  tokensBefore: number,
  tokensAfter: number,
  embeddingGen?: EmbeddingGenerator,
  config: CompactionQualityConfig = {
    entityRetentionWeight: 0.35,
    decisionRetentionWeight: 0.25,
    warningErrorRetentionWeight: 0.25,
    semanticSimilarityWeight: 0.15,
    qualityThreshold: 0.6,
    embeddingDriftWarningThreshold: 0.3,
  },
): Promise<CompactionQualityMetrics> {
  const entitiesBefore = extractEntities(textBefore);
  const entitiesAfter = extractEntities(textAfter);
  const decisionsBefore = extractDecisions(textBefore);
  const decisionsAfter = extractDecisions(textAfter);
  const warningsErrorsBefore = extractWarningsErrors(textBefore);
  const warningsErrorsAfter = extractWarningsErrors(textAfter);
  const entityRetention = computeRetention(entitiesBefore, entitiesAfter);
  const decisionRetention = computeRetention(decisionsBefore, decisionsAfter);
  const warningErrorRetention = computeRetention(
    warningsErrorsBefore,
    warningsErrorsAfter,
  );
  const compressionRatio = computeCompressionRatio(tokensBefore, tokensAfter);
  let embeddingDrift = 0;
  if (embeddingGen) {
    try {
      const [embBefore, embAfter] = await Promise.all([
        embeddingGen.generate(textBefore.slice(0, 2000)),
        embeddingGen.generate(textAfter.slice(0, 2000)),
      ]);
      embeddingDrift = 1 - cosineSimilarity(embBefore, embAfter);
    } catch {
      embeddingDrift = -1;
    }
  }
  const semanticSimilarity = embeddingDrift >= 0 ? 1 - embeddingDrift : 0.5;
  const tokensSavedTotal = tokensBefore - tokensAfter;
  const tokensSavedPerSession = tokensSavedTotal;
  const qualityScore = computeQualityScore(
    entityRetention,
    decisionRetention,
    warningErrorRetention,
    semanticSimilarity,
    config,
  );
  const safe = qualityScore >= config.qualityThreshold;
  return {
    compressionRatio,
    embeddingDrift,
    entityRetention,
    decisionRetention,
    warningErrorRetention,
    restoreSuccessRate: 1.0,
    recallSuccessAfterCompaction: entityRetention,
    tokensSavedTotal,
    tokensSavedPerSession,
    qualityScore,
    safe,
    entitiesBefore,
    entitiesAfter,
    decisionsBefore,
    decisionsAfter,
    warningsErrorsBefore,
    warningsErrorsAfter,
  };
}
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

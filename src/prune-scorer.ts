import type {
  Memory,
  PruneCandidate,
  PruneConfig,
  PruneReport,
  PruneRiskLevel,
  PruneSignal,
} from "./types.js";
import { DEFAULT_PRUNE_CONFIG } from "./types.js";
import { extractDecisions, extractEntities, extractWarningsErrors } from "./compaction-quality.js";

const DAY_MS = 1000 * 60 * 60 * 24;
const PROTECTED_PATTERNS = [
  /\b(security|CVE|vulnerability|exploit)\b/i,
  /\b(rollback|revert|regression)\b/i,
];

function computeAgeDays(createdAt: Date): number {
  const created = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
  const ageMs = Date.now() - created;
  if (ageMs < 1000) return 0;
  return Math.max(0, ageMs / DAY_MS);
}

function computeEntityDensity(content: string): number {
  return extractEntities(content).length / Math.max(1, content.split(/\s+/).length);
}

function isProtectedMemory(memory: Memory): { protected: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const content = memory.content || "";
  if (extractDecisions(content).length > 0) reasons.push("contains decisions");
  if (extractWarningsErrors(content).length > 0) reasons.push("contains errors/warnings");
  for (const pattern of PROTECTED_PATTERNS) {
    if (pattern.test(content)) {
      reasons.push(`contains protected pattern: ${pattern.source.replace(/\\b/g, "").replace(/\\/g, "")}`);
    }
  }
  if (extractEntities(content).length >= 3) reasons.push("high entity density (file/function/config references)");
  if ((memory.graphLinks ?? 0) >= 3) reasons.push(`high graph connectivity (${memory.graphLinks} links)`);
  if ((memory.recallCount ?? 0) >= 3) reasons.push(`frequently recalled (${memory.recallCount} times)`);
  if ((memory.importance ?? 0) >= 0.7) reasons.push(`high importance (${memory.importance})`);
  if (computeAgeDays(memory.lastAccessedAt || memory.createdAt) < 7) reasons.push("recently accessed");
  return { protected: reasons.length > 0, reasons };
}

function computePruneScore(
  memory: Memory,
  config: PruneConfig,
): { score: number; signals: PruneSignal } {
  const ageDays = computeAgeDays(memory.createdAt);
  const importance = memory.importance ?? 0.5;
  const recallCount = memory.recallCount ?? 0;
  const graphLinks = memory.graphLinks ?? 0;
  const entityDensity = computeEntityDensity(memory.content || "");
  const qualityScore = memory.qualityScore ?? 0.7;
  const sessionRelevance = memory.sessionId ? 0.5 : 0;
  const score = scoreMemory({
    ageDays,
    importance,
    recallCount,
    graphLinks,
    entityDensity,
    qualityScore,
    sessionRelevance,
  }, config);
  return {
    score,
    signals: { ageDays, importance, recallCount, graphLinks, entityDensity, qualityScore, sessionRelevance },
  };
}

function scoreMemory(signals: PruneSignal, config: PruneConfig): number {
  const ageScore = Math.min(1, signals.ageDays / config.maxAgeDays);
  const lowRecall = 1 - Math.min(1, signals.recallCount / config.minRecallCountForProtection);
  const lowGraph = 1 - Math.min(1, signals.graphLinks / config.minGraphLinksForProtection);
  const lowEntity = 1 - Math.min(1, signals.entityDensity / 0.3);
  return ageScore * 0.2
    + (1 - signals.importance) * 0.25
    + lowRecall * 0.2
    + lowGraph * 0.15
    + lowEntity * 0.05
    + (1 - signals.sessionRelevance) * 0.05
    + (1 - signals.qualityScore) * 0.1;
}

function classifyRisk(score: number): PruneRiskLevel {
  if (score >= 0.7) return "low";
  if (score >= 0.4) return "medium";
  return "high";
}

function reasonForPrune(
  _score: number,
  signals: PruneSignal,
  protectionReasons: string[],
): string {
  const parts: string[] = [];
  if (signals.ageDays > 30) parts.push(`old (${Math.round(signals.ageDays)}d)`);
  if (signals.importance < 0.3) parts.push("low importance");
  if (signals.recallCount === 0) parts.push("never recalled");
  if (signals.graphLinks <= 1) parts.push("weak graph links");
  if (signals.entityDensity < 0.05) parts.push("low entity density");
  if (signals.qualityScore < 0.6) parts.push("low quality score");
  if (protectionReasons.length > 0) parts.push(`protected: ${protectionReasons.join(", ")}`);
  return parts.length === 0 ? "marginal candidate" : parts.join("; ");
}

function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

export function pruneMemories(
  memories: Memory[],
  config: PruneConfig = DEFAULT_PRUNE_CONFIG,
): PruneReport {
  const candidates = memories.map((memory) => buildCandidate(memory, config));
  candidates.sort(compareCandidates);
  const prunable = candidates.filter((c) => !c.protected && c.riskLevel === "low");
  const limited = prunable.slice(0, config.maxCandidates);
  return {
    candidates: limited,
    totalCandidates: candidates.length,
    totalTokensSaved: limited.reduce((sum, c) => sum + c.tokensSaved, 0),
    riskDistribution: riskDistribution(candidates),
    protectedCount: candidates.filter((c) => c.protected).length,
    prunableCount: prunable.length,
    dryRun: config.dryRun !== false,
  };
}

function buildCandidate(memory: Memory, config: PruneConfig): PruneCandidate {
  const { score, signals } = computePruneScore(memory, config);
  const protection = isProtectedMemory(memory);
  return {
    memoryId: memory.id,
    action: "would_archive",
    riskLevel: classifyRisk(score),
    reason: reasonForPrune(score, signals, protection.reasons),
    tokensSaved: estimateTokens(memory.content || ""),
    signals,
    protected: protection.protected,
    protectionReasons: protection.reasons,
  };
}

function compareCandidates(a: PruneCandidate, b: PruneCandidate): number {
  if (a.protected !== b.protected) return a.protected ? 1 : -1;
  if (a.riskLevel === "high" && b.riskLevel !== "high") return 1;
  if (b.riskLevel === "high" && a.riskLevel !== "high") return -1;
  const riskOrder = { low: 0, medium: 1, high: 2 };
  return (riskOrder[b.riskLevel] ?? 0) - (riskOrder[a.riskLevel] ?? 0);
}

function riskDistribution(candidates: PruneCandidate[]): PruneReport["riskDistribution"] {
  return {
    low: candidates.filter((c) => c.riskLevel === "low").length,
    medium: candidates.filter((c) => c.riskLevel === "medium").length,
    high: candidates.filter((c) => c.riskLevel === "high").length,
  };
}

export function computeAgeDays_(createdAt: Date): number {
  return computeAgeDays(createdAt);
}

export function computeEntityDensity_(content: string): number {
  return computeEntityDensity(content);
}

export function isProtectedMemory_(memory: Memory): { protected: boolean; reasons: string[] } {
  return isProtectedMemory(memory);
}

export function computePruneScore_(memory: Memory, config: PruneConfig): { score: number; signals: PruneSignal } {
  return computePruneScore(memory, config);
}

export function buildReason_(signals: PruneSignal, protectionReasons: string[]): string {
  return reasonForPrune(0, signals, protectionReasons);
}

export function classifyRisk_(score: number): PruneRiskLevel {
  return classifyRisk(score);
}

import type { MemoryType, MemoryEmotion } from './types.js';
import { estimateTokens } from './token-bucket-analyzer.js';

export interface TypeQuotaConfig {
  maxTokens: number;
  preserveErrors: boolean;
  summaryPrefix: string;
}

const TYPE_QUOTAS: Record<MemoryType, TypeQuotaConfig> = {
  lesson:           { maxTokens: 800, preserveErrors: true,  summaryPrefix: '[LESSON]' },
  self_continuity:  { maxTokens: 600, preserveErrors: true,  summaryPrefix: '[CONTINUITY]' },
  procedural:       { maxTokens: 500, preserveErrors: true,  summaryPrefix: '[PROC]' },
  preference:       { maxTokens: 400, preserveErrors: false, summaryPrefix: '[PREF]' },
  conversation:     { maxTokens: 400, preserveErrors: true,  summaryPrefix: '[CONV]' },
  repo:             { maxTokens: 300, preserveErrors: true,  summaryPrefix: '[REPO]' },
  workspace:        { maxTokens: 300, preserveErrors: false, summaryPrefix: '[WS]' },
  episodic:         { maxTokens: 200, preserveErrors: false, summaryPrefix: '[EPI]' },
};

const ERROR_MARKERS = /\b(error|fail|exception|bug|crash|stack\s*trace|traceback|rollback|denied|fatal)\b/i;
const SIGNAL_LINE = /^(error|fail|warn|decision|goal|risk|constraint|next step|phase|src\/|test\/)/i;

export function applyTypeQuota(
  content: string,
  type: MemoryType,
  emotion?: MemoryEmotion,
): { content: string; compressed: boolean; originalTokens: number; finalTokens: number } {
  const quota = TYPE_QUOTAS[type] ?? TYPE_QUOTAS.episodic;
  const originalTokens = estimateTokens(content);

  if (originalTokens <= quota.maxTokens) {
    return { content, compressed: false, originalTokens, finalTokens: originalTokens };
  }

  const isError = quota.preserveErrors && (emotion === 'frustration' || ERROR_MARKERS.test(content));

  if (isError) {
    return { content, compressed: false, originalTokens, finalTokens: originalTokens };
  }

  const lines = content.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.length > 0);
  const kept: string[] = [];
  let keptTokens = 0;
  const prefixTokens = estimateTokens(quota.summaryPrefix);

  for (const line of lines) {
    const lineTokens = estimateTokens(line);
    if (keptTokens + lineTokens + prefixTokens > quota.maxTokens) break;
    if (kept.length < 4 || SIGNAL_LINE.test(line)) {
      kept.push(line);
      keptTokens += lineTokens;
    }
  }

  if (kept.length === 0) {
    const maxChars = Math.max(80, quota.maxTokens * 4 - quota.summaryPrefix.length - 20);
    return {
      content: `${quota.summaryPrefix} ${content.slice(0, maxChars)}... [quota-compressed]`,
      compressed: true,
      originalTokens,
      finalTokens: estimateTokens(content.slice(0, maxChars)) + prefixTokens + 3,
    };
  }

  const compressed = `${quota.summaryPrefix}\n${kept.join('\n')}\n[quota-compressed: ${originalTokens}→~${Math.ceil((keptTokens + prefixTokens) / 100) * 100} tok]`;
  return {
    content: compressed,
    compressed: true,
    originalTokens,
    finalTokens: estimateTokens(compressed),
  };
}

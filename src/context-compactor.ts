import type { CompactorConfig, ToolCallRecord, CompactionResult, CumulativeCompactionStats, CompactionQualityMetrics } from './types.js';
import { measureCompactionQuality, extractEntities, extractDecisions, extractWarningsErrors, computeRetention, computeQualityScore } from './compaction-quality.js';

const DEFAULT_QUALITY_CONFIG = {
  entityRetentionWeight: 0.35,
  decisionRetentionWeight: 0.25,
  warningErrorRetentionWeight: 0.25,
  semanticSimilarityWeight: 0.15,
  qualityThreshold: 0.6,
  embeddingDriftWarningThreshold: 0.3,
};

export class ContextCompactor {
  private config: CompactorConfig;
  private cumulativeStats: CumulativeCompactionStats;
  private lastResult: CompactionResult | null = null;
  private lastQuality: CompactionQualityMetrics | null = null;

  constructor(config: CompactorConfig) {
    this.config = {
      ...config,
      enabled: config.enabled ?? true,
      workingMemoryWindow: config.workingMemoryWindow ?? 8,
      minAgeMs: config.minAgeMs ?? 60000,
      maxOutputChars: config.maxOutputChars ?? 120,
      truncateInput: config.truncateInput ?? true,
      budgetCapEnabled: config.budgetCapEnabled ?? true,
      budgetCapPercent: config.budgetCapPercent ?? 30,
      budgetCapPressureThreshold: config.budgetCapPressureThreshold ?? 0.75,
      budgetCapMaxIterations: config.budgetCapMaxIterations ?? 3,
    };

    this.cumulativeStats = {
      totalCompactions: 0,
      totalPartsCompacted: 0,
      totalTokensSaved: 0,
      totalSemanticSignalsPreserved: 0,
      firstCompactedAt: null,
      lastCompactedAt: null,
    };
  }

  getStats(): CumulativeCompactionStats {
    return { ...this.cumulativeStats };
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  compact(
    toolCalls: ToolCallRecord[],
    inputStr?: string,
    messages?: any[]
  ): { compacted: string; result: CompactionResult; compactedCount: number } {
    if (!this.config.enabled || toolCalls.length === 0) {
      const raw = toolCalls.map(tc => this.formatRawToolCall(tc)).join('\n') + '\n' + (inputStr ?? '');
      const tokens = this.estimateTokens(raw);
      return {
        compacted: raw,
        compactedCount: 0,
        result: {
          totalToolParts: toolCalls.length,
          compactedParts: 0,
          keptRawParts: toolCalls.length,
          skippedParts: 0,
          beforeChars: raw.length,
          afterChars: raw.length,
          beforeTokens: tokens,
          afterTokens: tokens,
          tokensSaved: 0,
          savedPercent: 0,
          semanticSignalCountPreserved: 0,
          compactedAt: new Date(),
        },
      };
    }

    const now = Date.now();
    const windowSize = this.config.workingMemoryWindow ?? 8;
    const minAge = this.config.minAgeMs ?? 60000;

    // Sort by timestamp descending (most recent first)
    const sortedCalls = [...toolCalls].sort((a, b) => b.timestamp - a.timestamp);

    // Split tool calls into keep-raw (recent) and compactable (older)
    const keepRaw: ToolCallRecord[] = [];
    const compactable: ToolCallRecord[] = [];

    for (let i = 0; i < sortedCalls.length; i++) {
      const tc = sortedCalls[i];
      const status = this.getToolCallStatus(tc);
      const isRunning = status === 'running' || status === 'pending';

      if (i < windowSize) {
        keepRaw.push(tc);
      } else if (now - tc.timestamp < minAge) {
        keepRaw.push(tc);
      } else if (isRunning) {
        keepRaw.push(tc);
      } else {
        compactable.push(tc);
      }
    }

    // Mutate messages: replace compacted tool parts with compacted output
    if (messages) {
      let callIdx = 0;
      for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
        const msg = messages[msgIdx];
        const role = msg.info?.role ?? 'unknown';
        if (role === 'assistant') {
          for (let partIdx = 0; partIdx < (msg.parts?.length ?? 0); partIdx++) {
            const part = msg.parts[partIdx];
            if (part.type === 'tool') {
              if (callIdx < compactable.length) {
                // This tool part should be compacted
                part.state.output = this.formatCompactRef(compactable[callIdx]);
                part.compacted = true; // Mark as compacted
              }
              callIdx++;
            }
          }
        }
      }
    }

    // Budget cap check - if tool calls exceed configured percentage, compact more aggressively
    if (this.config.budgetCapEnabled && compactable.length > 0) {
      const toolStr = keepRaw.map(tc => this.formatRawToolCall(tc)).join('\n') +
        '\n' + compactable.map(tc => this.formatRawToolCall(tc)).join('\n');
      const totalStr = toolStr + '\n' + (inputStr ?? '');
      const toolTokens = this.estimateTokens(toolStr);
      const totalTokens = this.estimateTokens(totalStr);
      const toolPercent = totalTokens > 0 ? (toolTokens / totalTokens) * 100 : 0;

      const capPercent = this.config.budgetCapPercent ?? 30;
      const capTrigger = Math.floor(
        (this.config.budgetCapPressureThreshold ?? 0.75) * 4000
      );

      if (toolPercent > capPercent && totalTokens > capTrigger) {
        // Compact some of the keep-raw too
        const extraCount = Math.max(1, Math.floor(keepRaw.length * 0.3));
        const toCompact = keepRaw.splice(0, extraCount);
        compactable.push(...toCompact);
      }
    }

    // Build compacted output
    const compactedParts = compactable.map(tc => this.formatCompactRef(tc));
    const rawParts = keepRaw.map(tc => this.formatRawToolCall(tc));

    let compacted = '';
    if (compactedParts.length > 0) {
      compacted += compactedParts.join('\n');
    }
    if (rawParts.length > 0) {
      if (compacted) compacted += '\n';
      compacted += rawParts.join('\n');
    }
    if (inputStr) {
      if (compacted) compacted += '\n';
      compacted += inputStr;
    }

    const beforeStr = toolCalls.map(tc => this.formatRawToolCall(tc)).join('\n') + '\n' + (inputStr ?? '');
    const beforeTokens = this.estimateTokens(beforeStr);
    const afterTokens = this.estimateTokens(compacted);
    const tokensSaved = beforeTokens - afterTokens;
    const savedPercent = beforeTokens > 0 ? Math.round((tokensSaved / beforeTokens) * 10000) / 100 : 0;

    // Count semantic signals preserved
    let signalCount = 0;
    for (const tc of compactable) {
      if (tc.error) signalCount++;
      if (tc.filePath) signalCount++;
      if (tc.exitCode !== undefined && tc.exitCode !== 0) signalCount++;
    }

    this.cumulativeStats.totalCompactions++;
    this.cumulativeStats.totalPartsCompacted += compactable.length;
    this.cumulativeStats.totalTokensSaved += tokensSaved;
    this.cumulativeStats.totalSemanticSignalsPreserved += signalCount;
    this.cumulativeStats.lastCompactedAt = new Date();
    if (!this.cumulativeStats.firstCompactedAt) {
      this.cumulativeStats.firstCompactedAt = new Date();
    }

    const result: CompactionResult = {
      totalToolParts: toolCalls.length,
      compactedParts: compactable.length,
      keptRawParts: keepRaw.length,
      skippedParts: 0,
      beforeChars: beforeStr.length,
      afterChars: compacted.length,
      beforeTokens,
      afterTokens,
      tokensSaved,
      savedPercent,
      semanticSignalCountPreserved: signalCount,
      compactedAt: new Date(),
    };

    this.lastResult = result;

    // Measure compaction quality
    const allTextBefore = beforeStr;
    const allTextAfter = compacted;
    if (compactable.length > 0) {
      this.lastQuality = {
        compressionRatio: afterTokens / (beforeTokens || 1),
        embeddingDrift: -1,
        entityRetention: computeRetention(
          extractEntities(allTextBefore),
          extractEntities(allTextAfter),
        ),
        decisionRetention: computeRetention(
          extractDecisions(allTextBefore),
          extractDecisions(allTextAfter),
        ),
        warningErrorRetention: computeRetention(
          extractWarningsErrors(allTextBefore),
          extractWarningsErrors(allTextAfter),
        ),
        restoreSuccessRate: 1.0,
        recallSuccessAfterCompaction: computeRetention(
          extractEntities(allTextBefore),
          extractEntities(allTextAfter),
        ),
        tokensSavedTotal: tokensSaved,
        tokensSavedPerSession: tokensSaved,
        qualityScore: computeQualityScore(
          computeRetention(extractEntities(allTextBefore), extractEntities(allTextAfter)),
          computeRetention(extractDecisions(allTextBefore), extractDecisions(allTextAfter)),
          computeRetention(extractWarningsErrors(allTextBefore), extractWarningsErrors(allTextAfter)),
          0.5,
          DEFAULT_QUALITY_CONFIG,
        ),
        safe: false,
        entitiesBefore: extractEntities(allTextBefore),
        entitiesAfter: extractEntities(allTextAfter),
        decisionsBefore: extractDecisions(allTextBefore),
        decisionsAfter: extractDecisions(allTextAfter),
        warningsErrorsBefore: extractWarningsErrors(allTextBefore),
        warningsErrorsAfter: extractWarningsErrors(allTextAfter),
      };
      this.lastQuality.safe = this.lastQuality.qualityScore >= DEFAULT_QUALITY_CONFIG.qualityThreshold;
    } else {
      this.lastQuality = null;
    }

    return { compacted, result, compactedCount: compactable.length };
  }

  private formatRawToolCall(tc: ToolCallRecord): string {
    const args = tc.args ? JSON.stringify(tc.args).slice(0, this.config.maxOutputChars ?? 200) : '';
    const output = tc.output ? tc.output.slice(0, this.config.maxOutputChars ?? 200) : '';
    const error = tc.error ? `ERROR: ${tc.error.slice(0, this.config.maxOutputChars ?? 200)}` : '';
    return `TOOL: ${tc.tool}(${args}) ${output} ${error}`.trim();
  }

  private getToolCallStatus(tc: ToolCallRecord): string | undefined {
    if ((tc as any).state?.status) return (tc as any).state.status;
    if ((tc as any).status) return (tc as any).status;
    if (tc.error) return 'completed';
    if (tc.exitCode !== undefined) return 'completed';
    return undefined;
  }

  private formatCompactRef(tc: ToolCallRecord): string {
    const refId = `tool_${tc.sessionId}_${tc.timestamp}`;
    const output = tc.output ? tc.output.slice(0, this.config.maxOutputChars ?? 120) : '';
    const error = tc.error ? `ERROR: ${tc.error.slice(0, 100)}` : '';

    const signals: string[] = [];
    if (tc.error) signals.push('error');
    if (tc.filePath) signals.push('file:' + tc.filePath);
    if (tc.exitCode !== undefined && tc.exitCode !== 0) signals.push('exit:' + tc.exitCode);
    if (tc.tool === 'write' || tc.tool === 'edit' || tc.tool === 'patch') signals.push('mutation');

    const sigStr = signals.length > 0 ? ' signals=' + signals.join(',') : '';
    const args = tc.args ? JSON.stringify(tc.args).slice(0, 80) : '';
    return `TOOL_REF ${tc.tool}(${args})${sigStr} ${output} ${error}`.trim();
  }

  createExpandableRef(tc: ToolCallRecord): string {
    const refId = `tool_${tc.sessionId}_${tc.timestamp}`;
    const signals: string[] = [];
    if (tc.error) signals.push('error');
    if (tc.filePath) signals.push('file:' + tc.filePath);
    if (tc.tool === 'write' || tc.tool === 'edit' || tc.tool === 'patch') signals.push('mutation');

    const summary = (tc.output ?? '').slice(0, 80).replace(/"/g, "'");
    const sigStr = signals.length > 0 ? ' signals=' + signals.join(',') : '';
    return `[TOOL_REF id=${refId} tool=${tc.tool} type=${tc.tool} file=${tc.filePath ?? 'unknown'}${sigStr} summary="${summary}"]`;
  }

  getLastResult(): CompactionResult | null {
    return this.lastResult;
  }

  getLastQuality(): CompactionQualityMetrics | null {
    return this.lastQuality;
  }

  getCompactionStats(): CumulativeCompactionStats {
    return this.cumulativeStats;
  }

  getCumulativeStats(): CumulativeCompactionStats {
    return this.getCompactionStats();
  }
}

export function createContextCompactor(config?: Partial<CompactorConfig>): ContextCompactor {
  const defaultConfig: CompactorConfig = {
    enabled: true,
    workingMemoryWindow: 8,
    minAgeMs: 60000,
    maxOutputChars: 120,
    truncateInput: true,
    budgetCapEnabled: true,
    budgetCapPercent: 30,
    budgetCapPressureThreshold: 0.75,
    budgetCapMaxIterations: 3,
    ...config,
  };

  return new ContextCompactor(defaultConfig);
}
import { createHash } from 'node:crypto';
import type { CompactorConfig, ToolCallRecord, CompactionResult, CumulativeCompactionStats, CompactionQualityMetrics } from './types.js';
import { extractEntities, extractDecisions, extractWarningsErrors, computeRetention, computeQualityScore } from './compaction-quality.js';
import { isCompactedToolText } from './compaction-utils.js';

// --- Typed DTOs for message mutation and extended tool call state (Phase L4-C) ---

interface CompactableMessagePart {
  type?: string;
  tool?: string;
  state?: {
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    status?: string;
    time?: { start?: number; compacted?: number };
  };
  compacted?: boolean;
}

interface CompactableMessage {
  info?: { role?: string; sessionID?: string };
  parts?: CompactableMessagePart[];
}

interface ToolCallWithState extends ToolCallRecord {
  state?: { status?: string };
  status?: string;
}

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
    messages?: CompactableMessage[]
  ): { compacted: string; result: CompactionResult; compactedCount: number } {
    if (!this.config.enabled || toolCalls.length === 0) {
      const raw = [
        toolCalls.map(tc => this.formatFullToolCall(tc)).join('\n'),
        inputStr ?? '',
      ].filter(Boolean).join('\n');
      const tokens = this.estimateTokens(raw);
      const result: CompactionResult = {
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
      };
      this.lastResult = result;
      this.lastQuality = null;
      return { compacted: raw, compactedCount: 0, result };
    }

    const now = Date.now();
    const windowSize = this.config.workingMemoryWindow ?? 8;
    const minAge = this.config.minAgeMs ?? 60000;

    // Sort by timestamp descending (most recent first)
    const sortedCalls = [...toolCalls].sort((a, b) => b.timestamp - a.timestamp);

    // Split tool calls into keep-raw (recent) and compactable (older)
    const keepRaw: ToolCallRecord[] = [];
    const compactable: ToolCallRecord[] = [];
    const alreadyCompacted: ToolCallRecord[] = [];

    let eligibleIndex = 0;
    for (const tc of sortedCalls) {
      if (isCompactedToolText(tc.output) || isCompactedToolText(tc.error)) {
        alreadyCompacted.push(tc);
        continue;
      }
      const status = this.getToolCallStatus(tc);
      const isRunning = status === 'running' || status === 'pending';

      if (eligibleIndex < windowSize) {
        keepRaw.push(tc);
      } else if (now - tc.timestamp < minAge) {
        keepRaw.push(tc);
      } else if (isRunning) {
        keepRaw.push(tc);
      } else if (this.isWorthCompacting(tc)) {
        compactable.push(tc);
      } else {
        keepRaw.push(tc);
      }
      eligibleIndex++;
    }

    // Budget cap check — compact the oldest completed raw calls first. Never evict
    // running/pending calls, and never replace content with a larger reference.
    if (this.config.budgetCapEnabled) {
      const capPercent = this.config.budgetCapPercent ?? 30;
      const capTrigger = Math.floor(
        (this.config.budgetCapPressureThreshold ?? 0.75) * 4000
      );
      const maxIterations = Math.max(0, Math.floor(this.config.budgetCapMaxIterations ?? 3));

      for (let iteration = 0; iteration < maxIterations; iteration++) {
        const pressure = this.measureToolPressure(keepRaw, compactable, alreadyCompacted, inputStr);
        if (pressure.toolPercent <= capPercent || pressure.totalTokens <= capTrigger) break;

        const candidates = keepRaw
          .filter(tc => {
            const status = this.getToolCallStatus(tc);
            return status !== 'running' && status !== 'pending' && this.isWorthCompacting(tc);
          })
          .sort((a, b) => a.timestamp - b.timestamp);
        if (candidates.length === 0) break;

        const extraCount = Math.max(1, Math.floor(candidates.length * 0.3));
        const selected = new Set(candidates.slice(0, extraCount));
        for (let index = keepRaw.length - 1; index >= 0; index--) {
          if (!selected.has(keepRaw[index])) continue;
          compactable.push(keepRaw[index]);
          keepRaw.splice(index, 1);
        }
      }
    }

    const beforeStr = [
      toolCalls.map(tc => this.formatFullToolCall(tc)).join('\n'),
      inputStr ?? '',
    ].filter(Boolean).join('\n');
    let qualityRejectedCount = 0;
    let attemptedQuality: CompactionQualityMetrics | null = null;
    if (compactable.length > 0) {
      const prospectiveAfter = [
        compactable.map(tc => this.formatCompactedToolCall(tc)).join('\n'),
        alreadyCompacted.map(tc => this.formatFullToolCall(tc)).join('\n'),
        keepRaw.map(tc => this.formatFullToolCall(tc)).join('\n'),
        inputStr ?? '',
      ].filter(Boolean).join('\n');
      attemptedQuality = this.measureQuality(beforeStr, prospectiveAfter);
      if (!attemptedQuality.safe) {
        qualityRejectedCount = compactable.length;
        keepRaw.push(...compactable);
        compactable.length = 0;
      }
    }

    if (messages) {
      const compactableByTimestamp = new Map<number, ToolCallRecord[]>();
      for (const tc of compactable) {
        const matches = compactableByTimestamp.get(tc.timestamp) ?? [];
        matches.push(tc);
        compactableByTimestamp.set(tc.timestamp, matches);
      }

      for (const msg of messages) {
        if (msg.info?.role !== 'assistant') continue;
        for (const part of msg.parts ?? []) {
          if (part.type !== 'tool') continue;
          if (part.compacted || part.state?.time?.compacted) continue;
          if (isCompactedToolText(part.state?.output) || isCompactedToolText(part.state?.error)) continue;

          const partTimestamp = part.state?.time?.start ?? 0;
          if (partTimestamp === 0) continue;
          const candidates = compactableByTimestamp.get(partTimestamp);
          if (!candidates || candidates.length === 0) continue;
          const partSource = part.state?.status === 'error'
            ? part.state?.error ?? ''
            : part.state?.output ?? '';
          let candidateIndex = candidates.findIndex(tc =>
            (!part.tool || tc.tool === part.tool)
            && (tc.error ?? tc.output ?? '') === partSource
          );
          if (candidateIndex < 0) {
            candidateIndex = candidates.findIndex(tc => !part.tool || tc.tool === part.tool);
          }
          const matchingRecord = candidates.splice(candidateIndex >= 0 ? candidateIndex : 0, 1)[0];
          if (!matchingRecord) continue;

          if (!part.state) part.state = {};
          const compactRef = this.formatCompactRef(matchingRecord);
          if (part.state.status === 'error') part.state.error = compactRef;
          else part.state.output = compactRef;
          part.state.time = { ...part.state.time, start: partTimestamp, compacted: Date.now() };
          part.compacted = true;
        }
      }
    }

    // Build compacted output
    const compactedParts = compactable.map(tc => this.formatCompactRef(tc));
    const rawParts = [
      ...alreadyCompacted.map(tc => tc.output || tc.error || ''),
      ...keepRaw.map(tc => this.formatRawToolCall(tc)),
    ];

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

    const afterStr = [
      compactable.map(tc => this.formatCompactedToolCall(tc)).join('\n'),
      alreadyCompacted.map(tc => this.formatFullToolCall(tc)).join('\n'),
      keepRaw.map(tc => this.formatFullToolCall(tc)).join('\n'),
      inputStr ?? '',
    ].filter(Boolean).join('\n');
    const beforeTokens = this.estimateTokens(beforeStr);
    const afterTokens = this.estimateTokens(afterStr);
    const tokensSaved = compactable.length > 0 ? beforeTokens - afterTokens : 0;
    const savedPercent = beforeTokens > 0 && compactable.length > 0
      ? Math.round((tokensSaved / beforeTokens) * 10000) / 100
      : 0;

    // Count semantic signals preserved
    let signalCount = 0;
    for (const tc of compactable) {
      if (tc.error) signalCount++;
      if (toolFilePath(tc)) signalCount++;
      if (tc.exitCode !== undefined && tc.exitCode !== 0) signalCount++;
    }

    if (compactable.length > 0) {
      this.cumulativeStats.totalCompactions++;
      this.cumulativeStats.totalPartsCompacted += compactable.length;
      this.cumulativeStats.totalTokensSaved += tokensSaved;
      this.cumulativeStats.totalSemanticSignalsPreserved += signalCount;
      this.cumulativeStats.lastCompactedAt = new Date();
      if (!this.cumulativeStats.firstCompactedAt) {
        this.cumulativeStats.firstCompactedAt = new Date();
      }
    }

    const result: CompactionResult = {
      totalToolParts: toolCalls.length,
      compactedParts: compactable.length,
      keptRawParts: keepRaw.length + alreadyCompacted.length,
      skippedParts: alreadyCompacted.length + qualityRejectedCount,
      beforeChars: beforeStr.length,
      afterChars: afterStr.length,
      beforeTokens,
      afterTokens,
      tokensSaved,
      savedPercent,
      semanticSignalCountPreserved: signalCount,
      compactedAt: new Date(),
    };

    this.lastResult = result;

    // Keep the attempted quality result even when the gate rejected mutation.
    this.lastQuality = attemptedQuality;

    return { compacted, result, compactedCount: compactable.length };
  }



  private measureQuality(before: string, after: string): CompactionQualityMetrics {
    const beforeTokens = this.estimateTokens(before);
    const afterTokens = this.estimateTokens(after);
    const entitiesBefore = extractEntities(before);
    const entitiesAfter = extractEntities(after);
    const decisionsBefore = extractDecisions(before);
    const decisionsAfter = extractDecisions(after);
    const warningsErrorsBefore = extractWarningsErrors(before);
    const warningsErrorsAfter = extractWarningsErrors(after);
    const entityRetention = computeRetention(entitiesBefore, entitiesAfter);
    const decisionRetention = computeRetention(decisionsBefore, decisionsAfter);
    const warningErrorRetention = computeRetention(warningsErrorsBefore, warningsErrorsAfter);
    const qualityScore = computeQualityScore(
      entityRetention,
      decisionRetention,
      warningErrorRetention,
      0.5,
      DEFAULT_QUALITY_CONFIG,
    );
    return {
      compressionRatio: afterTokens / (beforeTokens || 1),
      embeddingDrift: -1,
      entityRetention,
      decisionRetention,
      warningErrorRetention,
      restoreSuccessRate: 1.0,
      recallSuccessAfterCompaction: entityRetention,
      tokensSavedTotal: beforeTokens - afterTokens,
      tokensSavedPerSession: beforeTokens - afterTokens,
      qualityScore,
      safe: qualityScore >= DEFAULT_QUALITY_CONFIG.qualityThreshold,
      entitiesBefore,
      entitiesAfter,
      decisionsBefore,
      decisionsAfter,
      warningsErrorsBefore,
      warningsErrorsAfter,
    };
  }

  private formatFullToolCall(tc: ToolCallRecord): string {
    const args = tc.args ? JSON.stringify(tc.args) : '';
    const output = tc.output ?? '';
    const error = tc.error ? `ERROR: ${tc.error}` : '';
    return `TOOL: ${tc.tool}(${args}) ${output} ${error}`.trim();
  }

  private formatCompactedToolCall(tc: ToolCallRecord): string {
    const args = tc.args ? JSON.stringify(tc.args) : '';
    return `TOOL: ${tc.tool}(${args}) ${this.formatCompactRef(tc)}`.trim();
  }

  private isWorthCompacting(tc: ToolCallRecord): boolean {
    const source = tc.error ?? tc.output ?? '';
    return this.formatCompactRef(tc).length < source.length;
  }

  getExpandableRefId(tc: ToolCallRecord): string {
    if (tc.toolCallId) return sanitizeRefToken(tc.toolCallId);
    if (tc.partId) return sanitizeRefToken(tc.partId);
    const digest = toolRecordDigest(tc);
    // A message can contain multiple tool parts. A bare message ID therefore is
    // not a unique recovery key; retain it for traceability and suffix a digest.
    if (tc.messageId) {
      return `${sanitizeRefToken(tc.messageId).slice(0, 140)}_${digest.slice(0, 12)}`;
    }
    return `tool_${digest.slice(0, 20)}`;
  }

  private measureToolPressure(
    keepRaw: ToolCallRecord[],
    compactable: ToolCallRecord[],
    alreadyCompacted: ToolCallRecord[],
    inputStr?: string,
  ): { toolPercent: number; totalTokens: number } {
    const toolStr = [
      compactable.map(tc => this.formatCompactedToolCall(tc)).join('\n'),
      alreadyCompacted.map(tc => this.formatFullToolCall(tc)).join('\n'),
      keepRaw.map(tc => this.formatFullToolCall(tc)).join('\n'),
    ].filter(Boolean).join('\n');
    const totalStr = [toolStr, inputStr ?? ''].filter(Boolean).join('\n');
    const toolTokens = this.estimateTokens(toolStr);
    const totalTokens = this.estimateTokens(totalStr);
    return {
      toolPercent: totalTokens > 0 ? (toolTokens / totalTokens) * 100 : 0,
      totalTokens,
    };
  }

  private formatRawToolCall(tc: ToolCallRecord): string {
    const args = tc.args ? JSON.stringify(tc.args).slice(0, this.config.maxOutputChars ?? 200) : '';
    const output = tc.output ? tc.output.slice(0, this.config.maxOutputChars ?? 200) : '';
    const error = tc.error ? `ERROR: ${tc.error.slice(0, this.config.maxOutputChars ?? 200)}` : '';
    return `TOOL: ${tc.tool}(${args}) ${output} ${error}`.trim();
  }

  private getToolCallStatus(tc: ToolCallRecord): string | undefined {
    const ext = tc as ToolCallWithState;
    if (ext.state?.status) return ext.state.status;
    if (ext.status) return ext.status;
    if (tc.error) return 'completed';
    if (tc.exitCode !== undefined) return 'completed';
    return undefined;
  }

  private formatCompactRef(tc: ToolCallRecord): string {
    return this.createExpandableRef(tc);
  }

  createExpandableRef(tc: ToolCallRecord): string {
    const refId = this.getExpandableRefId(tc);
    const signals: string[] = [];
    if (tc.error) signals.push('error');
    const filePath = toolFilePath(tc);
    if (filePath) signals.push('file');
    if (tc.exitCode !== undefined && tc.exitCode !== 0) signals.push(`exit:${tc.exitCode}`);
    if (tc.tool === 'write' || tc.tool === 'edit' || tc.tool === 'patch') signals.push('mutation');

    const source = tc.error ?? tc.output ?? '';
    const summarySource = tc.error ? `ERROR: ${tc.error}` : source;
    const summary = sanitizeMarkerValue(summarySource, this.config.maxOutputChars ?? 120);
    const file = sanitizeMarkerValue(filePath ?? 'unknown', 160);
    const tool = sanitizeRefToken(tc.tool || 'unknown');
    const sigStr = signals.length > 0 ? ` signals=${signals.join(',')}` : '';
    return `TOOL_REF id=${refId} fetch=context_fetch tool=${tool} file="${file}"${sigStr} summary="${summary}"`;
  }

  getLastResult(): CompactionResult | null {
    return this.lastResult;
  }

  getLastQuality(): CompactionQualityMetrics | null {
    return this.lastQuality;
  }

  getCompactionStats(): CumulativeCompactionStats {
    return { ...this.cumulativeStats };
  }

  getCumulativeStats(): CumulativeCompactionStats {
    return this.getCompactionStats();
  }
}


function toolRecordDigest(tc: ToolCallRecord): string {
  return createHash('sha256')
    .update(`${tc.sessionId}\0${tc.tool}\0${tc.timestamp}\0${tc.error ?? tc.output ?? ''}`)
    .digest('hex');
}

function toolFilePath(tc: ToolCallRecord): string | undefined {
  if (tc.filePath) return tc.filePath;
  const args = tc.args ?? {};
  for (const key of ['filePath', 'path', 'file', 'filename']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function sanitizeRefToken(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 180);
  return normalized || 'unknown';
}

function sanitizeMarkerValue(value: string, maxChars: number): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/["\\]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(0, maxChars));
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
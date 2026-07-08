import { estimateTokens } from './token-bucket-analyzer.js';
import type { GovernorMetrics } from './context-governor-types.js';

interface MonitorPart {
  type?: string;
  text?: string;
  state?: Record<string, unknown>;
}

interface MessageLike {
  info?: { role?: string };
  parts?: MonitorPart[];
}

function partText(part: MonitorPart): string {
  return String(part.text ?? part.state?.output ?? '');
}

function countTokens(parts: MonitorPart[] | undefined): number {
  return (parts ?? []).reduce((sum, part) => sum + estimateTokens(partText(part)), 0);
}

function isCheckpointRef(text: string): boolean {
  return text.startsWith('[CHECKPOINT_REF]');
}

function isDistilledState(text: string): boolean {
  return text.startsWith('[DISTILLED_STATE]');
}

function isMemoryBrief(text: string): boolean {
  return text.startsWith('[MEMORY_BRIEF]');
}

function isCompacted(text: string): boolean {
  return text.startsWith('[TOOL:')
    || text.startsWith('[CRITICAL_TOOL:')
    || text.includes('[COMPRESSED_CONTEXT:');
}

export function measureGovernorMetrics(
  messages: MessageLike[],
  projectedGrowth: number,
): GovernorMetrics {
  let totalTokens = 0;
  let toolOutputTokens = 0;
  let memoryBriefTokens = 0;
  let checkpointRefTokens = 0;
  let distilledStateTokens = 0;
  let rawMessagesKept = 0;
  let compactedMessages = 0;

  for (const message of messages) {
    const messageTokens = countTokens(message.parts);
    const role = message.info?.role ?? 'assistant';
    totalTokens += messageTokens;
    if (messageTokens > 0) rawMessagesKept++;
    for (const part of message.parts ?? []) {
      const text = partText(part);
      const tokens = estimateTokens(text);
      if (part.type === 'tool') toolOutputTokens += tokens;
      if (isMemoryBrief(text)) memoryBriefTokens += tokens;
      if (isCheckpointRef(text)) checkpointRefTokens += tokens;
      if (isDistilledState(text)) distilledStateTokens += tokens;
      if (role !== 'user' && isCompacted(text)) compactedMessages++;
    }
  }

  return {
    totalTokens,
    toolOutputTokens,
    rawHistoryTokens: Math.max(
      0,
      totalTokens - memoryBriefTokens - checkpointRefTokens - distilledStateTokens,
    ),
    memoryBriefTokens,
    checkpointRefTokens,
    distilledStateTokens,
    rawMessagesKept,
    compactedMessages,
    projectedNextTurnTokens: totalTokens + projectedGrowth,
    toolOutputShare: totalTokens > 0 ? toolOutputTokens / totalTokens : 0,
  };
}

// AssistantTextCompactor — Compress old assistant text parts.
// Conservative precision pass: preserves semantic signals, compresses verbose prose.

import { estimateTokens } from './token-bucket-analyzer.js';

// chars per token constant removed — unused

export interface AssistantCompactorConfig {
  enabled: boolean;
  workingAssistantWindow: number;  // Keep last N assistant messages raw (default 2)
  minTokens: number;               // Don't compress text parts under this token count (default 200)
  maxOutputChars: number;          // Max chars for compressed output (default 600)
}

export interface AssistantCompactionResult {
  messagesScanned: number;
  partsCompacted: number;
  beforeTokens: number;
  afterTokens: number;
  tokensSaved: number;
  savedPercent: number;
}

// Lines matching these patterns are always preserved
const PRESERVE_PATTERNS = [
  /\bMayday\b/i,
  /\bblocked\b/i,
  /\bfailed\b/i,
  /\berror\b/i,
  /\brisk\b/i,
  /\btest.*pass/i,
  /\btest.*fail/i,
  /\b[Pp]assed?\b.*\d+/,
  /\b\.\.\.\/|\\|\//,
  /\.(ts|js|py|rs|go|tsx|jsx|md|json|yaml|yml|toml|sql|sh)\b/,
  /```/,  // code blocks
  /^#\s+/,  // headings
  /^\|/,  // table rows
  /^\s*-\s+\*\*/,  // bold list items
];

function shouldPreserveLine(line: string): boolean {
  return PRESERVE_PATTERNS.some(p => p.test(line));
}

function extractPreservedLines(text: string): string[] {
  const lines = text.split('\n');
  const preserved: string[] = [];
  for (const line of lines) {
    if (shouldPreserveLine(line) && line.trim().length > 0) {
      preserved.push(line.trim());
    }
  }
  return preserved;
}

/**
 * Build a compacted summary of an assistant text part.
 */
function compactTextPart(
  text: string,
  maxChars: number,
): { compressed: string; preservedLines: string[] } {
  const originalTokens = estimateTokens(text);
  const preserved = extractPreservedLines(text);

  // If preserved lines alone are enough context, just use them
  const preservedText = preserved.join('\n');
  if (preservedText.length <= maxChars && preserved.length > 0) {
    const header = `[COMPACTED_ASSISTANT] Original: ~${originalTokens} tok | Kept: ${preserved.length} key lines`;
    return { compressed: `${header}\n${preservedText}`, preservedLines: preserved };
  }

  // Truncate preserved lines to fit budget
  const header = `[COMPACTED_ASSISTANT] Original: ~${originalTokens} tok | Kept: ${preserved.length} key lines (truncated)`;
  const headerLen = header.length + 2;
  const budget = maxChars - headerLen;
  if (budget <= 0 || preserved.length === 0) {
    return { compressed: header, preservedLines: preserved };
  }

  let kept = '';
  for (const line of preserved) {
    if ((kept.length + line.length + 1) > budget) break;
    kept += (kept ? '\n' : '') + line;
  }

  return { compressed: `${header}\n${kept}`, preservedLines: preserved };
}

/**
 * Compact old assistant text parts in the messages array.
 *
 * @param messages - The output.messages array (mutated in place)
 * @param config - Compaction configuration
 * @returns Result with before/after token counts
 */
export function compactAssistantText(
  messages: { info?: { role?: string; time?: { created?: number } }; parts?: any[] }[],
  config: AssistantCompactorConfig,
): AssistantCompactionResult {
  if (!config.enabled) {
    return { messagesScanned: 0, partsCompacted: 0, beforeTokens: 0, afterTokens: 0, tokensSaved: 0, savedPercent: 0 };
  }

  // Find assistant message indices (in order)
  const assistantIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].info?.role === 'assistant') {
      assistantIndices.push(i);
    }
  }

  // The last N assistant messages are protected
  const protectedCount = Math.min(config.workingAssistantWindow, assistantIndices.length);
  const protectedSet = new Set(assistantIndices.slice(assistantIndices.length - protectedCount));

  let messagesScanned = 0;
  let partsCompacted = 0;
  let beforeTokens = 0;
  let afterTokens = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.info?.role !== 'assistant') continue;
    messagesScanned++;

    // Skip protected (recent) assistant messages
    if (protectedSet.has(i)) continue;

    for (const part of msg.parts ?? []) {
      if (part.type !== 'text') continue;

      const text = String(part.text ?? '');
      const partTokens = estimateTokens(text);
      beforeTokens += partTokens;

      // Skip short text parts — not worth compacting
      if (partTokens < config.minTokens) {
        afterTokens += partTokens;
        continue;
      }

      const { compressed } = compactTextPart(text, config.maxOutputChars);
      part.text = compressed;
      const afterPartTokens = estimateTokens(compressed);
      afterTokens += afterPartTokens;
      partsCompacted++;
    }
  }

  const tokensSaved = beforeTokens - afterTokens;
  return {
    messagesScanned,
    partsCompacted,
    beforeTokens,
    afterTokens,
    tokensSaved,
    savedPercent: beforeTokens > 0 ? Math.round((tokensSaved / beforeTokens) * 100) : 0,
  };
}

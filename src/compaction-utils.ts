/**
 * Pure helper functions for the context compactor, extracted to keep
 * context-compactor.ts under the 200-line limit. These functions are
 * stateless — they take inputs and return outputs, no instance state.
 */

import { ToolPartLike, ToolPartLocation } from './compaction-types.js';
import { CompactorConfig, ToolCallGroup } from './types.js';

const COMPACTED_MARKER = '[COMPACTED]';
const OPENCODE_DISCARD_MARKER = '[Old tool result content cleared]';

export function hasOpenCodeDiscardMarker(part: ToolPartLike): boolean {
  const out = part.state?.output ?? '';
  const err = part.state?.error ?? '';
  return out.includes(OPENCODE_DISCARD_MARKER) || err.includes(OPENCODE_DISCARD_MARKER);
}

export function isCompactedToolText(text: string | undefined): boolean {
  const normalized = (text ?? '').trimStart();
  return normalized.startsWith(COMPACTED_MARKER)
    || normalized.startsWith('TOOL_REF')
    || normalized.startsWith('[TOOL_REF');
}

export function isAlreadyCompacted(part: ToolPartLike): boolean {
  if (hasOpenCodeDiscardMarker(part)) return false;
  if (part.state?.time?.compacted) return true;
  return isCompactedToolText(part.state?.output) || isCompactedToolText(part.state?.error);
}

export function adaptiveWindow(config: CompactorConfig, pressure?: number): number {
  if (pressure === undefined) return config.workingMemoryWindow;
  const clamped = Math.max(0, Math.min(1, pressure));
  return Math.round(2 + (config.workingMemoryWindow - 2) * (1 - clamped));
}

export function isRecentEnough(config: CompactorConfig, part: ToolPartLike): boolean {
  const start = part.state?.time?.start;
  return start ? Date.now() - start < config.minAgeMs : false;
}

export function collectToolParts(messages: { parts: unknown[] }[]): ToolPartLocation[] {
  const locations: ToolPartLocation[] = [];
  for (let mi = 0; mi < messages.length; mi++) {
    const parts = messages[mi].parts;
    if (!parts) continue;
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi] as ToolPartLike;
      if (part && part.type === 'tool') locations.push({ msgIndex: mi, partIndex: pi, part });
    }
  }
  return locations;
}

export function extractCriticalSignals(text: string): string[] {
  const patterns = [
    /error[:\s].{0,80}/gi, /warning[:\s].{0,80}/gi, /deprecat(?:ed|ion)[:\s].{0,60}/gi,
    /\bline\s+\d+[:\s].{0,60}/gi, /exit\s+code[:\s]?\d+/gi,
    /TODO[:\s].{0,40}/gi, /FIXME[:\s].{0,40}/gi,
  ];
  const signals: string[] = [];
  for (const p of patterns) {
    const m = text.match(p);
    if (!m) continue;
    const clean = m[0].trim().replace(/\n/g, ' ').slice(0, 80);
    if (!signals.some((s) => s.includes(clean.slice(0, 20)))) signals.push(clean);
  }
  return signals;
}

export function findMatchingGroup(groups: ToolCallGroup[], tool: string, file: string | null): ToolCallGroup | null {
  if (!groups || groups.length === 0) return null;
  if (file) {
    const byFile = groups.find((g) => g.filesChanged.some((f) => f.endsWith(file) || file.endsWith(f)));
    if (byFile) return byFile;
  }
  return groups.find((g) => g.toolCalls.some((c) => c.tool === tool)) ?? null;
}

export function extractFile(part: ToolPartLike): string | null {
  const input = part.state?.input;
  if (!input) return null;
  const path = (input as Record<string, unknown>).filePath ?? (input as Record<string, unknown>).path;
  if (typeof path !== 'string') return null;
  const segs = path.split(/[\\/]/);
  return segs.pop() ?? null;
}

export function truncateInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = typeof value === 'string' && value.length > 200 ? value.substring(0, 200) + '...[truncated]' : value;
  }
  return out;
}

export function measureTotalChars(locations: ToolPartLocation[]): number {
  let total = 0;
  for (const loc of locations) {
    const state = loc.part.state;
    if (!state) continue;
    total += (state.output ?? '').length + (state.error ?? '').length;
    const input = state.input;
    if (input) total += JSON.stringify(input).length;
  }
  return total;
}

export { COMPACTED_MARKER };

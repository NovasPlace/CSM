/**
 * Phase 6: Context Cache Runtime - Lazy Context Loading
 *
 * Scans messages for old, large context items, stores their full content in
 * the context_cache DB table, and replaces the in-prompt content with a
 * compact reference. The model can fetch the full content on demand via
 * context_fetch / context_search tools.
 */

import { DatabasePool } from './types.js';
import { storeItem, CacheKind } from './context-cache-store.js';
import { estimateTokens } from './token-bucket-analyzer.js';
import type { Redactor } from './redactor.js';

export interface CacheRuntimeConfig {
  recentTurnWindow: number;
  minTokensToCache: number;
}

export interface CacheRuntimeResult {
  itemsCached: number;
  tokensReplaced: number;
}

interface CacheToolPart {
  type: string;
  text?: string;
  tool?: string;
  state?: {
    status?: string;
    type?: string;
    output?: unknown;
    input?: Record<string, unknown>;
  };
}

interface CacheMessage {
  info?: { role?: string };
  parts?: CacheToolPart[];
}

function extractContent(part: CacheToolPart): { text: string; kind: CacheKind; summary: string; metadata: Record<string, unknown> } | null {
  if (part.type === 'text' && typeof part.text === 'string') {
    const text = part.text;
    if (text.length < 100) return null;
    const summary = text.slice(0, 80).replace(/\n/g, ' ');
    return { text, kind: 'turn', summary, metadata: {} };
  }
  if (part.type === 'tool' && part.state) {
    const state = part.state;
    if (state.status !== 'completed' && state.type !== 'completed') return null;
    const output = String(state.output ?? '');
    if (output.length < 100) return null;
    const tool = part.tool ?? 'unknown';
    const input = state.input ?? {};
    let kind: CacheKind = 'tool_output';
    let summary = output.slice(0, 80).replace(/\n/g, ' ');
    const metadata: Record<string, unknown> = { tool };
    if (tool === 'read' && input.filePath) {
      kind = 'file_read';
      metadata.filePath = input.filePath;
      summary = `read ${input.filePath}`;
    } else if (tool === 'bash') {
      metadata.command = String(input.command ?? '').slice(0, 80);
      summary = `bash: ${metadata.command}`;
    } else if (tool === 'edit' || tool === 'write') {
      metadata.filePath = input.filePath;
      summary = `${tool} ${input.filePath ?? ''}`;
    }
    if (output.includes('Error') || output.includes('error TS') || output.includes('FAIL')) {
      kind = 'error';
      summary = `error in ${tool}: ${output.slice(0, 60).replace(/\n/g, ' ')}`;
    }
    return { text: output, kind, summary, metadata };
  }
  return null;
}

function makeDisplayId(kind: string, msgIndex: number, partIndex: number): string {
  const prefix = kind === 'file_read' ? 'file' : kind === 'error' ? 'error' : kind === 'turn' ? 'turn' : 'tool';
  return `${prefix}_${msgIndex}_${partIndex}`;
}

export async function cacheOldContext(
  pool: DatabasePool,
  sessionId: string,
  messages: CacheMessage[],
  cfg: CacheRuntimeConfig,
  redactor?: Redactor,
): Promise<CacheRuntimeResult> {
  const total = messages.length;
  let itemsCached = 0;
  let tokensReplaced = 0;

  for (let i = 0; i < total; i++) {
    const msg = messages[i];
    if (!msg.parts) continue;
    const role = msg.info?.role ?? 'unknown';
    if (role === 'user') continue;
    if (i >= total - cfg.recentTurnWindow) continue;

    for (let p = 0; p < msg.parts.length; p++) {
      const part = msg.parts[p];
      const extracted = extractContent(part);
      if (!extracted) continue;
      const tokens = estimateTokens(extracted.text);
      if (tokens < cfg.minTokensToCache) continue;

      const displayId = makeDisplayId(extracted.kind, i, p);
      try {
        await storeItem(pool, {
          sessionId,
          displayId,
          kind: extracted.kind,
          createdAt: Date.now(),
          summary: extracted.summary,
          content: extracted.text,
          metadata: extracted.metadata,
          tokens,
          messageIndex: i,
        }, redactor);
      } catch (_e) {
        continue;
      }

      if (part.type === 'text') {
        part.text = `[CACHED: ${displayId}] ${extracted.summary}`;
      } else if (part.type === 'tool' && part.state) {
        part.state.output = `[CACHED: ${displayId}] ${extracted.summary}`;
      }
      tokensReplaced += tokens;
      itemsCached++;
    }
  }

  return { itemsCached, tokensReplaced };
}

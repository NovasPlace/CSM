/**
 * Phase 6: Context Cache Tools — Lazy Recall
 *
 * Tools the model uses to retrieve cached context on demand.
 * The prompt contains a compact manifest; the model fetches full details
 * only when needed.
 */
import { tool } from '@opencode-ai/plugin/tool';
import { DatabasePool } from './types.js';
import {
  fetchItem, searchItems, fetchFileReads,
  fetchLastError, fetchDecisions,
} from './context-cache-store.js';
import type { Redactor } from './redactor.js';

export interface ContextCacheToolDeps {
  pool: DatabasePool;
  redactor?: Redactor;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n[...truncated, ${s.length - max} more chars]`;
}

export function contextFetchTool(deps: ContextCacheToolDeps) {
  return tool({
    description: 'Retrieve full content of a cached context item by its display ID (e.g. turn_42, tool_88, file_read_15). Use when you need exact details that were summarized in the manifest.',
    args: {
      id: tool.schema.string().describe('The display_id from the manifest (e.g. turn_42)'),
      reason: tool.schema.string().optional().describe('Why you need this content (for audit trail)'),
    },
    async execute({ id, reason }, context) {
      const item = await fetchItem(deps.pool, context.sessionID, id);
      if (!item) {
        return {
          title: `context_fetch: ${id} (not found)`,
          output: `No cached item with display_id "${id}" in this session`,
          metadata: { found: false, displayId: id, reason: reason ?? null },
        };
      }
      return {
        title: `context_fetch: ${item.displayId}`,
        output: truncate(item.content, 12000),
        metadata: {
          found: true,
          displayId: item.displayId,
          kind: item.kind,
          summary: item.summary,
          tokens: item.tokens,
          fetchedForReason: reason ?? '(not specified)',
          fetchCount: item.fetchCount,
        },
      };
    },
  });
}

export function contextSearchTool(deps: ContextCacheToolDeps) {
  return tool({
    description: 'Search cached context items by keyword. Returns matching items with summaries (not full content). Use context_fetch to get full content of a specific result.',
    args: {
      query: tool.schema.string().describe('Search query (matches summaries and content)'),
      limit: tool.schema.number().optional().describe('Max results (default 10, max 20)'),
    },
    async execute({ query, limit }, context) {
      const cap = Math.min(limit ?? 10, 20);
      const results = await searchItems(deps.pool, context.sessionID, query, cap);
      const output = results.length === 0
        ? `No cached items matched "${query}"`
        : results.map((r) => `[${r.displayId}] (${r.kind}, ${r.tokens ?? '?'}t) ${r.summary}`).join('\n');
      return {
        title: `context_search: "${query}" (${results.length})`,
        output,
        metadata: {
          query,
          count: results.length,
          results: results.map((r) => ({
            displayId: r.displayId,
            kind: r.kind,
            summary: r.summary,
            tokens: r.tokens,
          })),
          hint: 'Use context_fetch(id) to retrieve full content of any result.',
        },
      };
    },
  });
}

export function contextFetchFileRegionTool(deps: ContextCacheToolDeps) {
  return tool({
    description: 'Retrieve a specific line range from a cached file read. Use when you need to re-examine a specific part of a file that was read earlier.',
    args: {
      filePath: tool.schema.string().describe('Path of the file to retrieve'),
      startLine: tool.schema.number().describe('First line to include (1-indexed)'),
      endLine: tool.schema.number().optional().describe('Last line to include (1-indexed, optional)'),
    },
    async execute({ filePath, startLine, endLine }, context) {
      const reads = await fetchFileReads(deps.pool, context.sessionID, filePath, deps.redactor);
      if (reads.length === 0) {
        return {
          title: `context_fetch_file_region: ${filePath} (not cached)`,
          output: `No cached file read for "${filePath}" in this session`,
          metadata: { found: false, filePath },
        };
      }
      const latest = reads[0];
      const lines = latest.content.split('\n');
      const end = endLine ?? startLine + 50;
      const region = lines.slice(startLine - 1, end).join('\n');
      return {
        title: `context_fetch_file_region: ${filePath} L${startLine}-${end}`,
        output: region,
        metadata: {
          found: true,
          filePath,
          displayId: latest.displayId,
          requestedRange: `lines ${startLine}-${end}`,
          totalLines: lines.length,
        },
      };
    },
  });
}

export function contextFetchLastErrorTool(deps: ContextCacheToolDeps) {
  return tool({
    description: 'Retrieve the most recent error from cached context. Use when you need to check what went wrong in a previous step.',
    args: {},
    async execute(_args, context) {
      const err = await fetchLastError(deps.pool, context.sessionID);
      if (!err) {
        return {
          title: 'context_fetch_last_error (none)',
          output: 'No errors cached in this session',
          metadata: { found: false },
        };
      }
      return {
        title: `context_fetch_last_error: ${err.displayId}`,
        output: truncate(err.content, 8000),
        metadata: {
          found: true,
          displayId: err.displayId,
          summary: err.summary,
          createdAt: new Date(err.createdAt).toISOString(),
        },
      };
    },
  });
}

export function contextFetchDecisionLogTool(deps: ContextCacheToolDeps) {
  return tool({
    description: 'Retrieve recent decisions from cached context. Use when you need to recall what decisions were made earlier in the session.',
    args: {
      limit: tool.schema.number().optional().describe('Max decisions to return (default 10, max 20)'),
    },
    async execute({ limit }, context) {
      const cap = Math.min(limit ?? 10, 20);
      const decisions = await fetchDecisions(deps.pool, context.sessionID, cap);
      const output = decisions.length === 0
        ? 'No decisions cached in this session'
        : decisions.map((d) => `[${d.displayId}] ${d.summary} (${new Date(d.createdAt).toISOString()})`).join('\n');
      return {
        title: `context_fetch_decision_log (${decisions.length})`,
        output,
        metadata: {
          count: decisions.length,
          decisions: decisions.map((d) => ({
            displayId: d.displayId,
            summary: d.summary,
            createdAt: new Date(d.createdAt).toISOString(),
          })),
        },
      };
    },
  });
}

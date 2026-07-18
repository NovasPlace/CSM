import { tool } from '@opencode-ai/plugin/tool';
import type { Database } from './database.js';
import { exportWiki } from './wiki-export.js';
import type { WikiExportResult } from './wiki-export-types.js';

interface WikiToolArgs {
  outputDir?: string;
  mode?: string;
  importanceThreshold?: number;
  includeLinked?: boolean;
  incremental?: boolean;
  prune?: boolean;
  dryRun?: boolean;
}

const DESCRIPTION =
  'Export CSM memories to an Obsidian-style wiki with [[wikilinks]], frontmatter, and entity index. ' +
  'Curated mode exports durable and high-importance memories; full mode exports all memories. ' +
  'Both modes write to the selected output directory and support incremental manifests.';

export function wikiExportTool(database: Database, projectId: string) {
  return tool({
    description: DESCRIPTION,
    args: wikiToolArguments(),
    async execute(args) {
      const result = await exportWiki(database, toExportOptions(args, projectId));
      return { title: resultTitle(result), output: resultOutput(result), metadata: result };
    },
  });
}

function wikiToolArguments() {
  return {
    outputDir: tool.schema.string().optional().describe('Output directory (default: "./wiki")'),
    mode: tool.schema.string().optional().describe('Export mode: "curated" (default) or "full"'),
    importanceThreshold: tool.schema.number().optional().describe('Curated importance threshold (default: 0.5)'),
    includeLinked: tool.schema.boolean().optional().describe('Include one-hop linked memories (default: true)'),
    incremental: tool.schema.boolean().optional().describe('Use incremental manifest comparison (default: true)'),
    prune: tool.schema.boolean().optional().describe('Prune obsolete manifest-owned files (default: false)'),
    dryRun: tool.schema.boolean().optional().describe('Report changes without writing (default: false)'),
  };
}

function toExportOptions(args: WikiToolArgs, projectId: string) {
  return {
    outputDir: args.outputDir ?? './wiki', projectId, mode: parseMode(args.mode),
    importanceThreshold: args.importanceThreshold ?? 0.5,
    includeLinked: args.includeLinked ?? true, incremental: args.incremental ?? true,
    prune: args.prune ?? false, dryRun: args.dryRun ?? false,
  };
}

function parseMode(value: string | undefined): 'curated' | 'full' {
  if (value === undefined || value === 'curated') return 'curated';
  if (value === 'full') return 'full';
  throw new Error(`Invalid wiki export mode: ${value}`);
}

function resultTitle(result: WikiExportResult): string {
  return `Wiki Export (${result.mode}${result.dryRun ? ', dry run' : ''})`;
}

function resultOutput(result: WikiExportResult): string {
  return [
    `Mode: ${result.mode}`, `Output: ${result.outputDir}`, `Eligible: ${result.totalEligible}`,
    `Created: ${result.notesCreated}`, `Updated: ${result.notesUpdated}`,
    `Removed: ${result.notesRemoved}`, `Unchanged: ${result.notesUnchanged}`,
    `DB manifest: ${result.databaseManifest.slice(0, 16)}...`,
    result.dryRun ? '(dry run - no files written)' : '',
  ].filter(Boolean).join('\n');
}

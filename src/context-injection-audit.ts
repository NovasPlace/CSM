import type { DatabasePool } from './types.js';
import { queryInjectionAudit } from './context-injection-audit-query.js';

export interface InjectionAuditReport {
  summary: {
    totalEvents: number;
    totalItems: number;
    byKind: Record<string, number>;
    byStatus: Record<string, number>;
    byEnvironment: Record<string, number>;
    byTrimLevel: Record<string, number>;
    dateRange: { earliest: string | null; latest: string | null };
  };
  provenance: {
    totalItems: number;
    bySourceKind: Record<string, number>;
    byDisposition: Record<string, number>;
    byProvenanceGranularity: Record<string, number>;
    memoryItemsWithId: number;
    memoryItemsWithoutId: number;
    nonMemoryItemsWithId: number;
    danglingMemoryReferences: number;
  };
  layerPressure: { byLayer: Array<{
    layerName: string; total: number; injected: number; trimmed: number; omitted: number; avgChars: number;
  }> };
  recallRelationship: {
    recalledMemories: number;
    injectedMemoryItems: number;
    recalledAndInjected: number;
    injectionRate: number | null;
  };
  trim: {
    trimmedEvents: number;
    trimmedItems: number;
    omittedItems: number;
    avgOriginalChars: null;
    avgFinalChars: number;
    compressionRatio: null;
  };
}

export interface InjectionAuditOptions {
  sessionId?: string;
  hours?: number;
}

export async function buildInjectionAuditReport(
  pool: DatabasePool,
  opts: InjectionAuditOptions = {},
): Promise<InjectionAuditReport> {
  return queryInjectionAudit(pool, opts);
}

export function formatAuditReport(report: InjectionAuditReport): { title: string; output: string } {
  const lines = [
    '# Context Injection Audit Report', '', '## Summary',
    `Total events: ${report.summary.totalEvents}`,
    `Total items: ${report.summary.totalItems}`,
    `Date range: ${dateRange(report.summary.dateRange)}`,
    '', 'By injection kind:', ...formatCounts(report.summary.byKind),
    '', 'By status:', ...formatCounts(report.summary.byStatus),
    '', '## Provenance', `Total items: ${report.provenance.totalItems}`,
    ...formatCounts(report.provenance.bySourceKind),
    `Memory items with ID: ${report.provenance.memoryItemsWithId}`,
    `Memory items without ID: ${report.provenance.memoryItemsWithoutId}`,
    `Dangling memory references: ${report.provenance.danglingMemoryReferences}`,
    '', '## Layer Pressure', ...formatLayers(report.layerPressure.byLayer),
    '', '## Recall Relationship',
    `Recalled memories: ${report.recallRelationship.recalledMemories}`,
    `Injected memory items: ${report.recallRelationship.injectedMemoryItems}`,
    `Recalled AND injected: ${report.recallRelationship.recalledAndInjected}`,
    `Injection rate: ${formatRate(report.recallRelationship.injectionRate)}`,
    '', '## Trim', `Trimmed events: ${report.trim.trimmedEvents}`,
    `Trimmed items: ${report.trim.trimmedItems}`,
    `Omitted items: ${report.trim.omittedItems}`,
    `Avg final chars: ${report.trim.avgFinalChars}`,
    'Avg original chars: unavailable (not recorded)',
  ];
  return { title: 'Context Injection Audit', output: lines.join('\n') };
}

function dateRange(range: InjectionAuditReport['summary']['dateRange']): string {
  return range.earliest ? `${range.earliest} -> ${range.latest}` : 'N/A';
}

function formatCounts(counts: Record<string, number>): string[] {
  return Object.entries(counts).map(([key, value]) => `  ${key}: ${value}`);
}

function formatLayers(layers: InjectionAuditReport['layerPressure']['byLayer']): string[] {
  if (layers.length === 0) return ['No layer data available.'];
  return layers.map((layer) => `  ${layer.layerName}: ${layer.total} items (${layer.injected} injected, ${layer.trimmed} trimmed, ${layer.omitted} omitted), avg ${layer.avgChars} chars`);
}

function formatRate(rate: number | null): string {
  return rate === null ? 'N/A' : `${(rate * 100).toFixed(1)}%`;
}

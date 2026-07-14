import { dialectFromPool, type QueryDialect } from './db/query-dialect.js';
import type { DatabasePool } from './types.js';
import type { InjectionAuditOptions, InjectionAuditReport } from './context-injection-audit.js';

interface QueryFilter { sql: string; params: unknown[]; }
interface EventRows { summary: InjectionAuditReport['summary']; trimmedEvents: number; }
interface ItemRows { provenance: InjectionAuditReport['provenance']; trimmed: number; omitted: number; avgFinalChars: number; }

export async function queryInjectionAudit(
  pool: DatabasePool,
  opts: InjectionAuditOptions,
): Promise<InjectionAuditReport> {
  const dialect = dialectFromPool(pool);
  const [events, items, layers, recallRelationship] = await Promise.all([
    queryEvents(pool, filterFor(opts, dialect)), queryItems(pool, filterFor(opts, dialect, 'e')),
    queryLayers(pool, filterFor(opts, dialect, 'e')), queryRecall(pool, filterFor(opts, dialect, 'e')),
  ]);
  return {
    summary: { ...events.summary, totalItems: items.provenance.totalItems },
    provenance: items.provenance,
    layerPressure: { byLayer: layers },
    recallRelationship,
    trim: {
      trimmedEvents: events.trimmedEvents, trimmedItems: items.trimmed, omittedItems: items.omitted,
      avgOriginalChars: null, avgFinalChars: items.avgFinalChars, compressionRatio: null,
    },
  };
}

function filterFor(opts: InjectionAuditOptions, dialect: QueryDialect, alias = ''): QueryFilter {
  if (opts.hours !== undefined && (!Number.isInteger(opts.hours) || opts.hours <= 0)) {
    throw new Error('hours must be a positive integer');
  }
  const column = (name: string) => alias ? `${alias}.${name}` : name;
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.hours !== undefined) {
    params.push(opts.hours);
    clauses.push(dialect === 'sqlite'
      ? `${column('recorded_at')} >= datetime('now', '-' || $${params.length} || ' hours')`
      : `${column('recorded_at')} >= now() - ($${params.length} * interval '1 hour')`);
  }
  if (opts.sessionId) {
    params.push(opts.sessionId);
    clauses.push(`${column('session_id')} = $${params.length}`);
  }
  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params };
}

async function queryEvents(pool: DatabasePool, filter: QueryFilter): Promise<EventRows> {
  const result = await pool.query(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN injection_kind = 'reentry' THEN 1 ELSE 0 END) AS reentry, SUM(CASE WHEN injection_kind = 'onboarding' THEN 1 ELSE 0 END) AS onboarding,
    SUM(CASE WHEN status = 'injected' THEN 1 ELSE 0 END) AS injected, SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
    SUM(CASE WHEN environment = 'production' THEN 1 ELSE 0 END) AS production, SUM(CASE WHEN environment = 'fixture' THEN 1 ELSE 0 END) AS fixture, SUM(CASE WHEN environment = 'benchmark' THEN 1 ELSE 0 END) AS benchmark,
    SUM(CASE WHEN trim_level = 'none' THEN 1 ELSE 0 END) AS trim_none, SUM(CASE WHEN trim_level = 'soft' THEN 1 ELSE 0 END) AS trim_soft, SUM(CASE WHEN trim_level = 'aggressive' THEN 1 ELSE 0 END) AS trim_aggressive,
    MIN(recorded_at) AS earliest, MAX(recorded_at) AS latest, SUM(CASE WHEN trim_level != 'none' THEN 1 ELSE 0 END) AS trimmed_events
    FROM context_injection_events WHERE 1=1${filter.sql}`, filter.params);
  const row = record(result.rows[0]);
  return { summary: {
    totalEvents: number(row.total), totalItems: 0,
    byKind: counts(row, ['reentry', 'onboarding']), byStatus: counts(row, ['injected', 'skipped', 'failed']),
    byEnvironment: counts(row, ['production', 'fixture', 'benchmark']),
    byTrimLevel: { none: number(row.trim_none), soft: number(row.trim_soft), aggressive: number(row.trim_aggressive) },
    dateRange: { earliest: text(row.earliest), latest: text(row.latest) },
  }, trimmedEvents: number(row.trimmed_events) };
}

async function queryItems(pool: DatabasePool, filter: QueryFilter): Promise<ItemRows> {
  const result = await pool.query(`SELECT COUNT(*) AS total, SUM(CASE WHEN i.source_kind = 'memory' THEN 1 ELSE 0 END) AS memory,
    SUM(CASE WHEN i.source_kind = 'document_section' THEN 1 ELSE 0 END) AS document_section, SUM(CASE WHEN i.source_kind = 'derived_state' THEN 1 ELSE 0 END) AS derived_state,
    SUM(CASE WHEN i.disposition = 'injected' THEN 1 ELSE 0 END) AS injected, SUM(CASE WHEN i.disposition = 'trimmed' THEN 1 ELSE 0 END) AS trimmed, SUM(CASE WHEN i.disposition = 'omitted' THEN 1 ELSE 0 END) AS omitted,
    SUM(CASE WHEN i.provenance_granularity = 'item' THEN 1 ELSE 0 END) AS item, SUM(CASE WHEN i.provenance_granularity = 'layer' THEN 1 ELSE 0 END) AS layer,
    SUM(CASE WHEN i.source_kind = 'memory' AND i.memory_id IS NOT NULL THEN 1 ELSE 0 END) AS mem_with_id,
    SUM(CASE WHEN i.source_kind = 'memory' AND i.memory_id IS NULL THEN 1 ELSE 0 END) AS mem_without_id,
    SUM(CASE WHEN i.source_kind != 'memory' AND i.memory_id IS NOT NULL THEN 1 ELSE 0 END) AS nonmem_with_id,
    AVG(i.char_count) AS avg_final_chars
    FROM context_injection_items i JOIN context_injection_events e ON i.injection_event_id = e.id WHERE 1=1${filter.sql}`, filter.params);
  const row = record(result.rows[0]);
  const dangling = await countDangling(pool, filter);
  return { provenance: {
    totalItems: number(row.total), bySourceKind: counts(row, ['memory', 'document_section', 'derived_state']),
    byDisposition: counts(row, ['injected', 'trimmed', 'omitted']), byProvenanceGranularity: counts(row, ['item', 'layer']),
    memoryItemsWithId: number(row.mem_with_id), memoryItemsWithoutId: number(row.mem_without_id),
    nonMemoryItemsWithId: number(row.nonmem_with_id), danglingMemoryReferences: dangling,
  }, trimmed: number(row.trimmed), omitted: number(row.omitted), avgFinalChars: Math.round(number(row.avg_final_chars)) };
}

async function countDangling(pool: DatabasePool, filter: QueryFilter): Promise<number> {
  const result = await pool.query(`SELECT COUNT(*) AS count FROM context_injection_items i
    JOIN context_injection_events e ON i.injection_event_id = e.id
    WHERE i.memory_id IS NOT NULL AND i.memory_id NOT IN (SELECT id FROM memories)${filter.sql}`, filter.params);
  return number(record(result.rows[0]).count);
}

async function queryLayers(pool: DatabasePool, filter: QueryFilter): Promise<InjectionAuditReport['layerPressure']['byLayer']> {
  const result = await pool.query(`SELECT i.layer_name, COUNT(*) AS total, SUM(CASE WHEN i.disposition = 'injected' THEN 1 ELSE 0 END) AS injected,
    SUM(CASE WHEN i.disposition = 'trimmed' THEN 1 ELSE 0 END) AS trimmed, SUM(CASE WHEN i.disposition = 'omitted' THEN 1 ELSE 0 END) AS omitted, AVG(i.char_count) AS avg_chars
    FROM context_injection_items i JOIN context_injection_events e ON i.injection_event_id = e.id
    WHERE 1=1${filter.sql} GROUP BY i.layer_name ORDER BY total DESC`, filter.params);
  return result.rows.map((value) => { const row = record(value); return {
    layerName: String(row.layer_name ?? ''), total: number(row.total), injected: number(row.injected),
    trimmed: number(row.trimmed), omitted: number(row.omitted), avgChars: Math.round(number(row.avg_chars)),
  }; });
}

async function queryRecall(pool: DatabasePool, filter: QueryFilter): Promise<InjectionAuditReport['recallRelationship']> {
  const injected = await pool.query(`SELECT COUNT(DISTINCT i.memory_id) AS count FROM context_injection_items i
    JOIN context_injection_events e ON i.injection_event_id = e.id WHERE i.memory_id IS NOT NULL${filter.sql}`, filter.params);
  try {
    const dialect = dialectFromPool(pool);
    const recallFilter = recallFilterFor(filter, dialect);
    const recalled = await pool.query(
      `SELECT COUNT(DISTINCT memory_id) AS count FROM memory_recall_events r WHERE 1=1${recallFilter.sql}`,
      recallFilter.params,
    );
    const recallSql = offsetFilter(recallFilter.sql, filter.params.length);
    const shared = await pool.query(`SELECT COUNT(DISTINCT i.memory_id) AS count FROM context_injection_items i
      JOIN context_injection_events e ON i.injection_event_id = e.id JOIN memory_recall_events r ON i.memory_id = r.memory_id
      WHERE i.memory_id IS NOT NULL${filter.sql}${recallSql}`, filter.params.concat(recallFilter.params));
    const recalledCount = number(record(recalled.rows[0]).count);
    const sharedCount = number(record(shared.rows[0]).count);
    return { recalledMemories: recalledCount, injectedMemoryItems: number(record(injected.rows[0]).count),
      recalledAndInjected: sharedCount, injectionRate: recalledCount ? sharedCount / recalledCount : null };
  } catch { return { recalledMemories: 0, injectedMemoryItems: number(record(injected.rows[0]).count), recalledAndInjected: 0, injectionRate: null }; }
}

function recallFilterFor(eventFilter: QueryFilter, dialect: QueryDialect): QueryFilter {
  const params = eventFilter.params.slice();
  const clauses: string[] = [];
  const hours = params[0];
  if (typeof hours === 'number') {
    clauses.push(dialect === 'sqlite'
      ? `r.recalled_at >= datetime('now', '-' || $1 || ' hours')`
      : `r.recalled_at >= now() - ($1 * interval '1 hour')`);
  }
  const sessionId = params.at(-1);
  if (typeof sessionId === 'string') {
    clauses.push(`r.session_id = $${params.length}`);
  }
  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params };
}

function offsetFilter(sql: string, offset: number): string {
  return sql.replace(/\$(\d+)/g, (_match, index: string) => `$${Number(index) + offset}`);
}

function record(value: unknown): Record<string, unknown> { return (value ?? {}) as Record<string, unknown>; }
function number(value: unknown): number { return Number(value ?? 0); }
function text(value: unknown): string | null { return value == null ? null : String(value); }
function counts(row: Record<string, unknown>, keys: string[]): Record<string, number> { return Object.fromEntries(keys.map((key) => [key, number(row[key])])); }

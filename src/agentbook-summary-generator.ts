import { createHash, randomUUID } from 'node:crypto';
import type { DatabasePool } from './types.js';
import { getLogger } from './logger.js';
import {
  dialectFromPool,
  parseArrayField,
  type QueryDialect,
} from './db/query-dialect.js';
import type { AgentBookEvent, AgentBookSummary } from './agentbook-types.js';
import {
  SUMMARY_THRESHOLD_CHARS,
  SUMMARY_THRESHOLD_EVENTS,
} from './agentbook-types.js';
import type { AgentBookEventStore } from './agentbook-event-store.js';

interface SummaryRow {
  summary_id: string;
  project_id: string;
  from_event_id: string;
  to_event_id: string;
  event_count: number | string;
  summary: string;
  open_questions: unknown;
  decisions: unknown;
  failures: unknown;
  next_steps: unknown;
  created_at: string | Date;
  model: string | null;
  source_hash: string;
}

function placeholder(_dialect: QueryDialect, index: number): string {
  // SQLite DatabasePool rewrites $N placeholders to ? and preserves parameter order.
  return `$${index}`;
}

function normalizeTimestamp(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const raw = String(value);
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

function strings(dialect: QueryDialect, value: unknown): string[] {
  return parseArrayField(dialect, value).filter((entry): entry is string => typeof entry === 'string');
}

function rowToSummary(dialect: QueryDialect, raw: unknown): AgentBookSummary {
  const row = raw as SummaryRow;
  return {
    summaryId: row.summary_id,
    projectId: row.project_id,
    fromEventId: row.from_event_id,
    toEventId: row.to_event_id,
    eventCount: Number(row.event_count),
    summary: row.summary,
    openQuestions: strings(dialect, row.open_questions),
    decisions: strings(dialect, row.decisions),
    failures: strings(dialect, row.failures),
    nextSteps: strings(dialect, row.next_steps),
    createdAt: normalizeTimestamp(row.created_at),
    model: row.model,
    sourceHash: row.source_hash,
  };
}

function asStrings(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function metadataStrings(event: AgentBookEvent, keys: string[]): string[] {
  return keys.flatMap((key) => asStrings(event.metadata[key]));
}

function unique(values: string[], max = 100): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= max) break;
  }
  return result;
}

function extractSummaryFields(events: AgentBookEvent[]): {
  decisions: string[];
  failures: string[];
  openQuestions: string[];
  nextSteps: string[];
} {
  const decisions: string[] = [];
  const failures: string[] = [];
  const openQuestions: string[] = [];
  const nextSteps: string[] = [];

  for (const event of events) {
    if (event.eventType === 'decision' || event.eventType === 'user_correction') {
      decisions.push(event.summary);
    }
    decisions.push(...metadataStrings(event, ['decision', 'decisions']));

    const failedOutcome = event.metadata.success === false || event.metadata.passed === false;
    if (event.eventType === 'failed_approach' || failedOutcome) failures.push(event.summary);
    failures.push(...metadataStrings(event, ['failure', 'failures', 'error']));

    if (event.summary.trim().endsWith('?')) openQuestions.push(event.summary);
    openQuestions.push(...metadataStrings(event, ['openQuestions', 'open_questions', 'questions']));

    nextSteps.push(...metadataStrings(event, [
      'nextSteps', 'next_steps', 'nextAction', 'next_action', 'todo', 'todos',
    ]));
  }

  return {
    decisions: unique(decisions),
    failures: unique(failures),
    openQuestions: unique(openQuestions),
    nextSteps: unique(nextSteps),
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, stableValue(object[key])]));
  }
  return value;
}

function eventContent(events: AgentBookEvent[]): string {
  return JSON.stringify(stableValue(events.map((event) => ({
    eventId: event.eventId,
    projectId: event.projectId,
    sessionId: event.sessionId,
    eventType: event.eventType,
    timestamp: event.timestamp,
    actor: event.actor,
    summary: event.summary,
    evidenceRefs: event.evidenceRefs,
    files: event.files,
    command: event.command,
    result: event.result,
    environment: event.environment,
    metadata: event.metadata,
    status: event.status,
  }))));
}

function buildSummaryText(events: AgentBookEvent[]): string {
  const counts = new Map<string, number>();
  for (const event of events) counts.set(event.eventType, (counts.get(event.eventType) ?? 0) + 1);
  const eventMix = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([type, count]) => `${type}: ${count}`)
    .join(', ');
  const latest = events.slice(-8).map((event) => `- [${event.eventType}] ${event.summary}`);
  return [
    `Captured ${events.length} AgentBook events from ${events[0].timestamp} through ${events.at(-1)?.timestamp}.`,
    `Event mix: ${eventMix || 'none'}.`,
    '',
    'Latest activity:',
    ...latest,
  ].join('\n');
}

export class AgentBookSummaryGenerator {
  constructor(
    private readonly pool: DatabasePool,
    private readonly eventStore: AgentBookEventStore,
  ) {}

  async maybeGenerate(projectId: string): Promise<AgentBookSummary | null> {
    const latest = await this.getLatestSummary(projectId);
    const events = latest
      ? await this.eventStore.getEventsSince(projectId, latest.toEventId)
      : await this.loadAllEvents(projectId);
    if (events.length === 0) return null;

    const characters = eventContent(events).length;
    if (events.length < SUMMARY_THRESHOLD_EVENTS && characters < SUMMARY_THRESHOLD_CHARS) return null;
    return this.generate(projectId, events[0].eventId, events.at(-1)?.eventId ?? events[0].eventId);
  }

  async generate(projectId: string, fromEventId: string, toEventId: string): Promise<AgentBookSummary> {
    const allEvents = await this.loadAllEvents(projectId);
    const fromIndex = allEvents.findIndex((event) => event.eventId === fromEventId);
    const toIndex = allEvents.findIndex((event) => event.eventId === toEventId);
    if (fromIndex < 0) throw new Error(`AgentBook summary start event not found: ${fromEventId}`);
    if (toIndex < 0) throw new Error(`AgentBook summary end event not found: ${toEventId}`);
    if (fromIndex > toIndex) throw new Error('AgentBook summary range is reversed');

    const events = allEvents.slice(fromIndex, toIndex + 1);
    const sourceContent = eventContent(events);
    const sourceHash = createHash('sha256').update(sourceContent).digest('hex');
    const existing = await this.findExisting(projectId, fromEventId, toEventId, sourceHash);
    if (existing) return existing;

    const extracted = extractSummaryFields(events);
    const summaryId = `summary_${randomUUID()}`;
    const dialect = dialectFromPool(this.pool);
    const values: unknown[] = [
      summaryId,
      projectId,
      fromEventId,
      toEventId,
      events.length,
      buildSummaryText(events),
      JSON.stringify(extracted.openQuestions),
      JSON.stringify(extracted.decisions),
      JSON.stringify(extracted.failures),
      JSON.stringify(extracted.nextSteps),
      null,
      sourceHash,
    ];
    const params = values.map((_, index) => placeholder(dialect, index + 1)).join(', ');
    await this.pool.query(
      `INSERT INTO agentbook_summaries
         (summary_id, project_id, from_event_id, to_event_id, event_count, summary,
          open_questions, decisions, failures, next_steps, model, source_hash)
       VALUES (${params})`,
      values,
    );
    const created = await this.getSummary(summaryId);
    if (!created) throw new Error(`AgentBook summary insert could not be read back: ${summaryId}`);
    getLogger().debug(`AgentBook summary generated: ${summaryId}`, { projectId });
    return created;
  }

  async getLatestSummary(projectId: string): Promise<AgentBookSummary | null> {
    const dialect = dialectFromPool(this.pool);
    const result = await this.pool.query(
      `SELECT * FROM agentbook_summaries
       WHERE project_id = ${placeholder(dialect, 1)}
       ORDER BY created_at DESC, summary_id DESC
       LIMIT 1`,
      [projectId],
    );
    return result.rows.length > 0 ? rowToSummary(dialect, result.rows[0]) : null;
  }

  async listSummaries(projectId: string, limit: number): Promise<AgentBookSummary[]> {
    const dialect = dialectFromPool(this.pool);
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(10_000, Math.trunc(limit))) : 20;
    const result = await this.pool.query(
      `SELECT * FROM agentbook_summaries
       WHERE project_id = ${placeholder(dialect, 1)}
       ORDER BY created_at DESC, summary_id DESC
       LIMIT ${placeholder(dialect, 2)}`,
      [projectId, safeLimit],
    );
    return result.rows.map((row) => rowToSummary(dialect, row));
  }

  private async getSummary(summaryId: string): Promise<AgentBookSummary | null> {
    const dialect = dialectFromPool(this.pool);
    const result = await this.pool.query(
      `SELECT * FROM agentbook_summaries WHERE summary_id = ${placeholder(dialect, 1)}`,
      [summaryId],
    );
    return result.rows.length > 0 ? rowToSummary(dialect, result.rows[0]) : null;
  }

  private async findExisting(
    projectId: string,
    fromEventId: string,
    toEventId: string,
    sourceHash: string,
  ): Promise<AgentBookSummary | null> {
    const dialect = dialectFromPool(this.pool);
    const result = await this.pool.query(
      `SELECT * FROM agentbook_summaries
       WHERE project_id = ${placeholder(dialect, 1)}
         AND from_event_id = ${placeholder(dialect, 2)}
         AND to_event_id = ${placeholder(dialect, 3)}
         AND source_hash = ${placeholder(dialect, 4)}
       ORDER BY created_at DESC, summary_id DESC
       LIMIT 1`,
      [projectId, fromEventId, toEventId, sourceHash],
    );
    return result.rows.length > 0 ? rowToSummary(dialect, result.rows[0]) : null;
  }

  private async loadAllEvents(projectId: string): Promise<AgentBookEvent[]> {
    const pageSize = 1_000;
    const descending: AgentBookEvent[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.eventStore.listEvents({ projectId, limit: pageSize, offset });
      descending.push(...page);
      if (page.length < pageSize) break;
    }
    return descending.reverse();
  }
}

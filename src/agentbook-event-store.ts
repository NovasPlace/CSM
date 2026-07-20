import { randomUUID } from 'node:crypto';
import type { DatabasePool } from './types.js';
import { getLogger } from './logger.js';
import {
  dialectFromPool,
  parseArrayField,
  parseJsonField,
  type QueryDialect,
} from './db/query-dialect.js';
import type {
  AgentBookEvent,
  AgentBookEventInput,
  AgentBookEventType,
} from './agentbook-types.js';
import { Redactor, redactJsonValue } from './redactor.js';

interface EventRow {
  event_id: string;
  project_id: string;
  session_id: string | null;
  event_type: string;
  occurred_at: string | Date;
  actor: string;
  summary: string;
  evidence_refs: unknown;
  files: unknown;
  command: string | null;
  result: string | null;
  environment: unknown;
  metadata: unknown;
  status: string;
}

let lastEventMillis = 0;
let eventSequence = 0;

function generateEventId(): string {
  const now = Date.now();
  if (now === lastEventMillis) eventSequence += 1;
  else {
    lastEventMillis = now;
    eventSequence = 0;
  }
  const timePart = now.toString(36).padStart(10, '0');
  const sequencePart = eventSequence.toString(36).padStart(4, '0');
  return `evt_${timePart}_${sequencePart}_${randomUUID()}`;
}

function placeholder(_dialect: QueryDialect, index: number): string {
  // SQLite DatabasePool rewrites $N placeholders to ? and preserves parameter order.
  return `$${index}`;
}

function jsonDocument(value: unknown): string {
  return JSON.stringify(value);
}

function normalizeTimestamp(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const raw = String(value);
  const sqliteTimestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const parsed = new Date(sqliteTimestamp);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

function stringArray(dialect: QueryDialect, value: unknown): string[] {
  return parseArrayField(dialect, value).filter((entry): entry is string => typeof entry === 'string');
}

function stringRecord(dialect: QueryDialect, value: unknown): Record<string, string> {
  const parsed = parseJsonField(dialect, value);
  const entries = Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return Object.fromEntries(entries);
}

function rowToEvent(dialect: QueryDialect, raw: unknown): AgentBookEvent {
  const row = raw as EventRow;
  return {
    eventId: row.event_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    eventType: row.event_type as AgentBookEventType,
    timestamp: normalizeTimestamp(row.occurred_at),
    actor: row.actor,
    summary: row.summary,
    evidenceRefs: stringArray(dialect, row.evidence_refs),
    files: stringArray(dialect, row.files),
    command: row.command,
    result: row.result,
    environment: stringRecord(dialect, row.environment),
    metadata: parseJsonField(dialect, row.metadata),
    status: row.status as AgentBookEvent['status'],
  };
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isFinite(value)) return 50;
  return Math.max(1, Math.min(1_000_000, Math.trunc(value)));
}

function normalizeOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

export class AgentBookEventStore {
  constructor(
    private readonly pool: DatabasePool,
    private readonly redactor: Redactor = new Redactor(),
  ) {}

  async append(input: AgentBookEventInput): Promise<AgentBookEvent> {
    if (!input.projectId.trim()) throw new Error('AgentBook event projectId is required');
    if (!input.summary.trim()) throw new Error('AgentBook event summary is required');

    const dialect = dialectFromPool(this.pool);
    const eventId = generateEventId();
    const safe = redactJsonValue(this.redactor, {
      actor: input.actor ?? 'agent',
      summary: input.summary,
      evidenceRefs: input.evidenceRefs ?? [],
      files: input.files ?? [],
      command: input.command ?? null,
      result: input.result ?? null,
      environment: input.environment ?? {},
      metadata: input.metadata ?? {},
    });
    const values: unknown[] = [
      eventId,
      input.projectId,
      input.sessionId ?? null,
      input.eventType,
      safe.actor,
      safe.summary,
      jsonDocument(safe.evidenceRefs),
      jsonDocument(safe.files),
      safe.command,
      safe.result,
      jsonDocument(safe.environment),
      jsonDocument(safe.metadata),
      input.status ?? 'active',
    ];
    const placeholders = values.map((_, index) => placeholder(dialect, index + 1)).join(', ');

    await this.pool.query(
      `INSERT INTO agentbook_events
         (event_id, project_id, session_id, event_type, actor, summary,
          evidence_refs, files, command, result, environment, metadata, status)
       VALUES (${placeholders})`,
      values,
    );

    const event = await this.getEvent(eventId);
    if (!event) throw new Error(`AgentBook event insert could not be read back: ${eventId}`);
    getLogger().debug(`AgentBook event appended: ${eventId}`, {
      projectId: input.projectId,
      sessionId: input.sessionId ?? undefined,
    });
    return event;
  }

  async listEvents(options: {
    projectId?: string;
    sessionId?: string;
    eventType?: AgentBookEventType;
    limit?: number;
    offset?: number;
  } = {}): Promise<AgentBookEvent[]> {
    const dialect = dialectFromPool(this.pool);
    const conditions: string[] = [];
    const params: unknown[] = [];
    const addCondition = (column: string, value: unknown): void => {
      params.push(value);
      conditions.push(`${column} = ${placeholder(dialect, params.length)}`);
    };

    if (options.projectId !== undefined) addCondition('project_id', options.projectId);
    if (options.sessionId !== undefined) addCondition('session_id', options.sessionId);
    if (options.eventType !== undefined) addCondition('event_type', options.eventType);

    params.push(normalizeLimit(options.limit));
    const limitPlaceholder = placeholder(dialect, params.length);
    params.push(normalizeOffset(options.offset));
    const offsetPlaceholder = placeholder(dialect, params.length);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT * FROM agentbook_events
       ${where}
       ORDER BY occurred_at DESC, event_id DESC
       LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
      params,
    );
    return result.rows.map((row) => this.sanitizeEvent(dialect, row));
  }

  async getEvent(eventId: string): Promise<AgentBookEvent | null> {
    const dialect = dialectFromPool(this.pool);
    const result = await this.pool.query(
      `SELECT * FROM agentbook_events WHERE event_id = ${placeholder(dialect, 1)}`,
      [eventId],
    );
    return result.rows.length > 0 ? this.sanitizeEvent(dialect, result.rows[0]) : null;
  }

  async countEvents(projectId?: string): Promise<number> {
    return this.countDistinct('COUNT(*)', projectId);
  }

  async countSessions(projectId?: string): Promise<number> {
    return this.countDistinct('COUNT(DISTINCT session_id)', projectId, true);
  }

  async getRecentEvents(projectId: string, limit: number): Promise<AgentBookEvent[]> {
    return this.listEvents({ projectId, limit });
  }

  async getEventsSince(projectId: string, sinceEventId: string): Promise<AgentBookEvent[]> {
    const dialect = dialectFromPool(this.pool);
    const result = await this.pool.query(
      `WITH anchor AS (
         SELECT occurred_at, event_id
         FROM agentbook_events
         WHERE project_id = ${placeholder(dialect, 1)}
           AND event_id = ${placeholder(dialect, 2)}
       )
       SELECT event.*
       FROM agentbook_events event
       CROSS JOIN anchor
       WHERE event.project_id = ${placeholder(dialect, 3)}
         AND (
           event.occurred_at > anchor.occurred_at
           OR (event.occurred_at = anchor.occurred_at AND event.event_id > anchor.event_id)
         )
       ORDER BY event.occurred_at ASC, event.event_id ASC`,
      [projectId, sinceEventId, projectId],
    );
    return result.rows.map((row) => this.sanitizeEvent(dialect, row));
  }

  private async countDistinct(expression: string, projectId?: string, sessionsOnly = false): Promise<number> {
    const dialect = dialectFromPool(this.pool);
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (projectId !== undefined) {
      params.push(projectId);
      conditions.push(`project_id = ${placeholder(dialect, params.length)}`);
    }
    if (sessionsOnly) conditions.push('session_id IS NOT NULL');
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT ${expression} AS count_value FROM agentbook_events ${where}`,
      params,
    );
    const row = result.rows[0] as { count_value?: unknown } | undefined;
    return Number(row?.count_value ?? 0);
  }

  private sanitizeEvent(dialect: QueryDialect, row: unknown): AgentBookEvent {
    const event = rowToEvent(dialect, row);
    const safe = redactJsonValue(this.redactor, {
      actor: event.actor,
      summary: event.summary,
      evidenceRefs: event.evidenceRefs,
      files: event.files,
      command: event.command,
      result: event.result,
      environment: event.environment,
      metadata: event.metadata,
    });
    return { ...event, ...safe };
  }
}

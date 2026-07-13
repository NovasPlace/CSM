import type { DatabasePool } from './types.js';
import { getLogger } from './logger.js';
import {
  dialectFromPool,
  parseArrayField,
  type QueryDialect,
} from './db/query-dialect.js';
import type { AgentBookCurrentState, AgentBookEvent } from './agentbook-types.js';
import type { AgentBookEventStore } from './agentbook-event-store.js';

interface StateRow {
  project_id: string;
  active_goal: string | null;
  current_phase: string | null;
  latest_summary_id: string | null;
  recent_changes: unknown;
  blockers: unknown;
  next_steps: unknown;
  rules_version: number | string;
  updated_at: string | Date;
  event_count: number | string;
  session_count: number | string;
}

interface LatestSummaryRow {
  summary_id: string;
  next_steps: unknown;
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

function stringArray(dialect: QueryDialect, value: unknown): string[] {
  return parseArrayField(dialect, value).filter((entry): entry is string => typeof entry === 'string');
}

function rowToState(dialect: QueryDialect, raw: unknown): AgentBookCurrentState {
  const row = raw as StateRow;
  return {
    projectId: row.project_id,
    activeGoal: row.active_goal,
    currentPhase: row.current_phase,
    latestSummaryId: row.latest_summary_id,
    recentChanges: stringArray(dialect, row.recent_changes),
    blockers: stringArray(dialect, row.blockers),
    nextSteps: stringArray(dialect, row.next_steps),
    rulesVersion: Number(row.rules_version),
    updatedAt: normalizeTimestamp(row.updated_at),
    eventCount: Number(row.event_count),
    sessionCount: Number(row.session_count),
  };
}

function metadataString(event: AgentBookEvent, keys: string[]): string | null {
  for (const key of keys) {
    const value = event.metadata[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function metadataStrings(event: AgentBookEvent, keys: string[]): string[] {
  const values: string[] = [];
  for (const key of keys) {
    const value = event.metadata[key];
    if (typeof value === 'string' && value.trim()) values.push(value.trim());
    if (Array.isArray(value)) {
      values.push(...value.filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim()).filter(Boolean));
    }
  }
  return values;
}

function deriveGoal(events: AgentBookEvent[]): string | null {
  let active: { id: string | null; text: string } | null = null;
  for (const event of events) {
    if (event.eventType === 'goal_set' && event.status !== 'superseded') {
      active = {
        id: metadataString(event, ['goalId', 'goal_id']),
        text: metadataString(event, ['goal', 'activeGoal', 'active_goal']) ?? event.summary,
      };
      continue;
    }
    if (event.eventType !== 'goal_achieved' || !active) continue;
    const achievedId = metadataString(event, ['goalId', 'goal_id']);
    const achievedText = metadataString(event, ['goal', 'activeGoal', 'active_goal']);
    if (!achievedId && !achievedText) active = null;
    else if (achievedId && achievedId === active.id) active = null;
    else if (achievedText && achievedText === active.text) active = null;
  }
  return active?.text ?? null;
}

function derivePhase(events: AgentBookEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const phase = metadataString(events[index], ['currentPhase', 'current_phase', 'phase']);
    if (phase) return phase;
  }
  return null;
}

function formatChange(event: AgentBookEvent): string {
  if (event.files.length === 0) return event.summary;
  return `${event.summary} (${event.files.join(', ')})`;
}

function deriveRecentChanges(events: AgentBookEvent[]): string[] {
  const changeTypes = new Set(['file_modified', 'file_created', 'commit']);
  return events
    .filter((event) => changeTypes.has(event.eventType) && event.status !== 'superseded')
    .slice(-10)
    .reverse()
    .map(formatChange);
}

function blockerKey(event: AgentBookEvent): string {
  const explicit = metadataString(event, ['blockerId', 'blocker_id', 'blocker']);
  if (explicit) return explicit.toLowerCase();
  return event.summary
    .toLowerCase()
    .replace(/^\s*(blocker(?:\s+identified)?|resolved|blocker\s+resolved)\s*[:-]?\s*/i, '')
    .trim();
}

function blockerText(event: AgentBookEvent): string {
  return metadataString(event, ['blocker', 'description']) ?? event.summary;
}

function deriveBlockers(events: AgentBookEvent[]): string[] {
  const active = new Map<string, string>();
  for (const event of events) {
    if (event.eventType === 'blocker_identified') {
      const key = blockerKey(event);
      if (event.status === 'resolved') active.delete(key);
      else if (event.status !== 'superseded') active.set(key, blockerText(event));
    } else if (event.eventType === 'blocker_resolved') {
      active.delete(blockerKey(event));
    }
  }
  return [...active.values()];
}

function latestGoalNextSteps(events: AgentBookEvent[]): string[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].eventType !== 'goal_set') continue;
    const steps = metadataStrings(events[index], ['nextSteps', 'next_steps', 'nextAction', 'next_action']);
    if (steps.length > 0) return steps;
  }
  return [];
}

export class AgentBookStateProjector {
  constructor(
    private readonly pool: DatabasePool,
    private readonly eventStore: AgentBookEventStore,
  ) {}

  async project(projectId: string): Promise<AgentBookCurrentState> {
    const events = await this.loadAllEvents(projectId);
    const latestSummary = await this.loadLatestSummary(projectId);
    const [eventCount, sessionCount, rulesVersion] = await Promise.all([
      this.eventStore.countEvents(projectId),
      this.eventStore.countSessions(projectId),
      this.loadRulesVersion(),
    ]);
    const summarySteps = latestSummary
      ? stringArray(dialectFromPool(this.pool), latestSummary.next_steps)
      : [];
    const state: AgentBookCurrentState = {
      projectId,
      activeGoal: deriveGoal(events),
      currentPhase: derivePhase(events),
      latestSummaryId: latestSummary?.summary_id ?? null,
      recentChanges: deriveRecentChanges(events),
      blockers: deriveBlockers(events),
      nextSteps: summarySteps.length > 0 ? summarySteps : latestGoalNextSteps(events),
      rulesVersion,
      updatedAt: new Date().toISOString(),
      eventCount,
      sessionCount,
    };
    await this.upsertState(state);
    getLogger().debug('AgentBook current state projected', { projectId });
    return state;
  }

  async upsertState(state: AgentBookCurrentState): Promise<void> {
    const dialect = dialectFromPool(this.pool);
    const values: unknown[] = [
      state.projectId,
      state.activeGoal,
      state.currentPhase,
      state.latestSummaryId,
      JSON.stringify(state.recentChanges),
      JSON.stringify(state.blockers),
      JSON.stringify(state.nextSteps),
      state.rulesVersion,
      state.updatedAt,
      state.eventCount,
      state.sessionCount,
    ];
    const params = values.map((_, index) => placeholder(dialect, index + 1)).join(', ');
    const columns = `(project_id, active_goal, current_phase, latest_summary_id,
      recent_changes, blockers, next_steps, rules_version, updated_at, event_count, session_count)`;
    if (dialect === 'sqlite') {
      await this.pool.query(
        `INSERT OR REPLACE INTO agentbook_current_state ${columns} VALUES (${params})`,
        values,
      );
      return;
    }
    await this.pool.query(
      `INSERT INTO agentbook_current_state ${columns}
       VALUES (${params})
       ON CONFLICT (project_id) DO UPDATE SET
         active_goal = EXCLUDED.active_goal,
         current_phase = EXCLUDED.current_phase,
         latest_summary_id = EXCLUDED.latest_summary_id,
         recent_changes = EXCLUDED.recent_changes,
         blockers = EXCLUDED.blockers,
         next_steps = EXCLUDED.next_steps,
         rules_version = EXCLUDED.rules_version,
         updated_at = EXCLUDED.updated_at,
         event_count = EXCLUDED.event_count,
         session_count = EXCLUDED.session_count`,
      values,
    );
  }

  async getState(projectId: string): Promise<AgentBookCurrentState | null> {
    const dialect = dialectFromPool(this.pool);
    const result = await this.pool.query(
      `SELECT * FROM agentbook_current_state WHERE project_id = ${placeholder(dialect, 1)}`,
      [projectId],
    );
    return result.rows.length > 0 ? rowToState(dialect, result.rows[0]) : null;
  }

  private async loadLatestSummary(projectId: string): Promise<LatestSummaryRow | null> {
    const dialect = dialectFromPool(this.pool);
    const result = await this.pool.query(
      `SELECT summary_id, next_steps
       FROM agentbook_summaries
       WHERE project_id = ${placeholder(dialect, 1)}
       ORDER BY created_at DESC, summary_id DESC
       LIMIT 1`,
      [projectId],
    );
    return result.rows.length > 0 ? result.rows[0] as LatestSummaryRow : null;
  }

  private async loadRulesVersion(): Promise<number> {
    const result = await this.pool.query(
      'SELECT COALESCE(SUM(version), 0) AS rules_version FROM agentbook_rules',
    );
    const row = result.rows[0] as { rules_version?: unknown } | undefined;
    return Number(row?.rules_version ?? 0);
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

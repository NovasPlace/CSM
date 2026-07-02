import type { DatabasePool } from './types.js';
import type { FailureTrace, FailureTraceStorage } from './failure-trace-types.js';
import { redact } from './redactor.js';
import { ilikeExpr, dialectFromPool } from './db/query-dialect.js';

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS failure_traces (
  id SERIAL PRIMARY KEY,
  problem TEXT NOT NULL,
  attempted_action TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('failed', 'partial', 'succeeded', 'abandoned')),
  failure_reason TEXT,
  diagnosis TEXT,
  correction TEXT,
  lesson_created TEXT,
  later_behavior_change TEXT,
  evidence_anchors TEXT[] DEFAULT '{}',
  linked_phase INTEGER,
  linked_commit TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by_session TEXT NOT NULL,
  related_trace_ids INTEGER[] DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS failure_traces_session_idx ON failure_traces(created_by_session);
CREATE INDEX IF NOT EXISTS failure_traces_phase_idx ON failure_traces(linked_phase);
CREATE INDEX IF NOT EXISTS failure_traces_created_idx ON failure_traces(created_at DESC);
`;

export class FailureTraceStore implements FailureTraceStorage {
  constructor(private pool: DatabasePool) {}

  async initialize(): Promise<void> {
    await this.pool.query(CREATE_TABLE_SQL);
  }

  async store(trace: Omit<FailureTrace, 'id' | 'createdAt'>): Promise<FailureTrace> {
    const {
      problem,
      attemptedAction,
      result,
      failureReason,
      diagnosis,
      correction,
      lessonCreated,
      laterBehaviorChange,
      evidenceAnchors,
      linkedPhase,
      linkedCommit,
      createdBySession,
      relatedTraceIds = [],
    } = trace;

    const res = await this.pool.query(
      `INSERT INTO failure_traces
        (problem, attempted_action, result, failure_reason, diagnosis, correction,
         lesson_created, later_behavior_change, evidence_anchors, linked_phase,
         linked_commit, created_by_session, related_trace_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id, created_at`,
      [
        problem,
        attemptedAction,
        result,
        failureReason ?? null,
        diagnosis ?? null,
        correction ?? null,
        lessonCreated ?? null,
        laterBehaviorChange ?? null,
        evidenceAnchors,
        linkedPhase ?? null,
        linkedCommit ?? null,
        createdBySession,
        relatedTraceIds,
      ]
    );

    const inserted = resultRow(res.rows[0]);

    return {
      ...trace,
      id: inserted.id,
      createdAt: inserted.created_at,
    };
  }

  async recallByProblem(problemPattern: string, limit = 10): Promise<FailureTrace[]> {
    const d = dialectFromPool(this.pool);
    const res = await this.pool.query(
      `SELECT * FROM failure_traces
       WHERE ${ilikeExpr(d, 'problem', 1)}
       ORDER BY created_at DESC
       LIMIT $2`,
      [`%${problemPattern}%`, limit]
    );
    return this.mapRows(res.rows);
  }

  async recallBySession(sessionId: string, limit = 10): Promise<FailureTrace[]> {
    const res = await this.pool.query(
      `SELECT * FROM failure_traces
       WHERE created_by_session = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [sessionId, limit]
    );
    return this.mapRows(res.rows);
  }

  async recallByPhase(phase: number, limit = 10): Promise<FailureTrace[]> {
    const res = await this.pool.query(
      `SELECT * FROM failure_traces
       WHERE linked_phase = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [phase, limit]
    );
    return this.mapRows(res.rows);
  }

  async recallRelated(traceId: number, limit = 5): Promise<FailureTrace[]> {
    const res = await this.pool.query(
      `SELECT * FROM failure_traces
       WHERE $1 = ANY(related_trace_ids) OR id = ANY(
         SELECT related_trace_ids FROM failure_traces WHERE id = $1
       )
       ORDER BY created_at DESC
       LIMIT $2`,
      [traceId, limit]
    );
    return this.mapRows(res.rows);
  }

  async linkToMilestone(traceId: number, milestoneId: string): Promise<void> {
    await this.pool.query(
      `UPDATE failure_traces SET related_trace_ids = array_append(related_trace_ids, $1) WHERE id = $2`,
      [traceId, milestoneId]
    );
  }

  async getTracesForNarrative(limit = 20): Promise<FailureTrace[]> {
    const res = await this.pool.query(
      `SELECT * FROM failure_traces
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return this.mapRows(res.rows);
  }

  private mapRows(rows: any[]): FailureTrace[] {
    if (!rows || rows.length === 0) return [];
    const parseJson = (v: any) => {
      if (typeof v === 'string') {
        try { return JSON.parse(v); } catch { return v; }
      }
      return v;
    };
    return rows.map(r => ({
      id: r.id,
      problem: r.problem,
      attemptedAction: r.attempted_action,
      result: r.result,
      failureReason: r.failure_reason ? redact(r.failure_reason).text : undefined,
      diagnosis: r.diagnosis ? redact(r.diagnosis).text : undefined,
      correction: r.correction ? redact(r.correction).text : undefined,
      lessonCreated: r.lesson_created ? redact(r.lesson_created).text : undefined,
      laterBehaviorChange: r.later_behavior_change ? redact(r.later_behavior_change).text : undefined,
      evidenceAnchors: parseJson(r.evidence_anchors) ?? [],
      driftSummary: r.drift_summary ? redact(r.drift_summary).text : undefined,
      linkedPhase: r.linked_phase,
      linkedCommit: r.linked_commit,
      relatedTraceIds: parseJson(r.related_trace_ids) ?? [],
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      createdBySession: r.created_by_session,
    }));
  }
}

function resultRow(row: unknown): { id: number; created_at: string } {
  return row as { id: number; created_at: string };
}

export function formatFailureTraceForInjection(trace: FailureTrace, maxTokens = 500): string {
  const parts = [
    `[Failure Trace #${trace.id}]`,
    `Problem: ${trace.problem}`,
    `Attempted: ${trace.attemptedAction}`,
    `Result: ${trace.result}`,
  ];

  if (trace.failureReason) parts.push(`Failure: ${trace.failureReason}`);
  if (trace.diagnosis) parts.push(`Diagnosis: ${trace.diagnosis}`);
  if (trace.correction) parts.push(`Correction: ${trace.correction}`);
  if (trace.lessonCreated) parts.push(`Lesson: ${trace.lessonCreated}`);
  if (trace.laterBehaviorChange) parts.push(`Behavior change: ${trace.laterBehaviorChange}`);
  if (trace.evidenceAnchors.length) parts.push(`Anchors: ${trace.evidenceAnchors.join(', ')}`);
  if (trace.linkedPhase) parts.push(`Phase: ${trace.linkedPhase}`);
  if (trace.linkedCommit) parts.push(`Commit: ${trace.linkedCommit}`);

  let text = parts.join('\n');
  if (text.length > maxTokens * 4) {
    text = text.slice(0, maxTokens * 4) + '... [truncated]';
  }
  return redact(text).text;
}

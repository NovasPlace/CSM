import { FailureTraceStore } from './failure-trace-store.js';
import { getActiveGoal } from './goal-schema.js';
import type { DatabasePool } from './types.js';

export interface BridgeGoalSummary {
  id: string;
  description: string;
  createdAt: number;
  context: Record<string, unknown>;
}

export interface BridgeFailureSummary {
  problem: string;
  result: string;
  correction?: string;
  lessonCreated?: string;
  createdAt: string;
}

export interface BridgeSessionStateSummary {
  activeGoal: BridgeGoalSummary | null;
  latestFailure: BridgeFailureSummary | null;
}

export async function loadBridgeSessionState(
  pool: DatabasePool,
  sessionId: string,
): Promise<BridgeSessionStateSummary> {
  const [goal, failure] = await Promise.all([
    getActiveGoal(pool, sessionId),
    loadLatestFailure(pool, sessionId),
  ]);

  return {
    activeGoal: goal
      ? {
          id: goal.id,
          description: goal.description,
          createdAt: goal.created_at,
          context: goal.context ?? {},
        }
      : null,
    latestFailure: failure,
  };
}

async function loadLatestFailure(
  pool: DatabasePool,
  sessionId: string,
): Promise<BridgeFailureSummary | null> {
  const tableReady = await hasFailureTraceTable(pool);
  if (!tableReady) return null;

  const store = new FailureTraceStore(pool);
  const traces = await store.recallBySession(sessionId, 1);
  const trace = traces[0];
  if (!trace) return null;
  return {
    problem: trace.problem,
    result: trace.result,
    correction: trace.correction,
    lessonCreated: trace.lessonCreated,
    createdAt: trace.createdAt,
  };
}

async function hasFailureTraceTable(pool: DatabasePool): Promise<boolean> {
  const result = await pool.query(`SELECT to_regclass('public.failure_traces') AS regclass_name`);
  return Boolean((result.rows[0] as { regclass_name?: string | null }).regclass_name);
}

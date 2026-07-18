import type { DatabasePool } from './types.js';
import { updateGoal, type Goal } from './goal-schema.js';

/** Update a goal only after proving it belongs to the active session. */
export async function updateGoalForSession(
  pool: DatabasePool,
  goalId: string,
  sessionId: string,
  patch: { description?: string; status?: Goal['status']; context?: Record<string, unknown> },
): Promise<Goal | null> {
  const owned = await pool.query(
    'SELECT 1 FROM goals WHERE id = $1 AND session_id = $2 LIMIT 1',
    [goalId, sessionId],
  );
  if (owned.rows.length === 0) return null;
  return updateGoal(pool, goalId, patch);
}

import type { DatabasePool } from './types.js';
import type { ReEntryConfig } from './reentry-types.js';

export interface ReEntryBudgetDecision {
  baseMaxChars: number;
  effectiveMaxChars: number;
  priorTurnCount: number | null;
  tier: 'unknown' | 'short' | 'medium' | 'long';
}

export function deriveAdaptiveReentryBudget(
  config: ReEntryConfig,
  priorTurnCount: number | null,
): ReEntryBudgetDecision {
  const tier = budgetTier(priorTurnCount);
  const multiplier = tier === 'short' ? 0.6 : tier === 'medium' ? 0.8 : 1;
  return {
    baseMaxChars: config.maxChars,
    effectiveMaxChars: Math.min(
      config.maxChars,
      Math.max(config.minLayerChars * 4, Math.floor(config.maxChars * multiplier)),
    ),
    priorTurnCount,
    tier,
  };
}

export async function resolveAdaptiveReentryBudget(
  pool: DatabasePool,
  config: ReEntryConfig,
  sessionId: string,
  projectId: string,
): Promise<ReEntryBudgetDecision> {
  return deriveAdaptiveReentryBudget(config, await priorTurns(pool, sessionId, projectId));
}

function budgetTier(turnCount: number | null): ReEntryBudgetDecision['tier'] {
  if (turnCount === null) return 'unknown';
  if (turnCount <= 8) return 'short';
  if (turnCount <= 24) return 'medium';
  return 'long';
}

async function priorTurns(
  pool: DatabasePool,
  sessionId: string,
  projectId: string,
): Promise<number | null> {
  try {
    const result = await pool.query(
      `SELECT turn_count FROM sessions
       WHERE project_id = $1 AND id != $2
       ORDER BY updated_at DESC LIMIT 1`,
      [projectId, sessionId],
    );
    const value = (result.rows[0] as Record<string, unknown> | undefined)?.turn_count;
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

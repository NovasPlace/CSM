/**
 * Phase 6 — Context Rollover: configuration types and defaults.
 *
 * Soft rollover tracks cumulative tokens per session. When the cumulative
 * total exceeds `rolloverAtTotalSessionTokens`, old messages are archived
 * into the context cache and replaced with a continuation brief + last N
 * turns. The prompt size must drop under `targetInputTokensAfterRollover`
 * and must never exceed `failClosedOverInputTokens`.
 */

export interface RolloverConfig {
  /** Master switch for the rollover subsystem. */
  enabled: boolean;
  /** Cumulative session tokens that trigger a rollover. */
  rolloverAtTotalSessionTokens: number;
  /** Target prompt token count after rollover replaces old context. */
  targetInputTokensAfterRollover: number;
  /** Hard cap — if the transformed prompt is still over this, fail closed. */
  failClosedOverInputTokens: number;
  /** Number of recent turns (user→assistant→tool chains) to keep after rollover. */
  recentTurnsToKeep: number;
  /** Maximum tokens for the continuation brief itself. */
  maxBriefTokens: number;
  /** Whether to log rollover events to stdout. */
  logEnabled: boolean;
}

export const DEFAULT_ROLLOVER_CONFIG: RolloverConfig = {
  enabled: true,
  rolloverAtTotalSessionTokens: 90_000,
  targetInputTokensAfterRollover: 20_000,
  failClosedOverInputTokens: 40_000,
  recentTurnsToKeep: 2,
  maxBriefTokens: 3_000,
  logEnabled: true,
};

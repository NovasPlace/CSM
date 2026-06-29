import type { DatabasePool } from './types.js';

export interface SessionTokenUsage {
  sessionId: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  turnCount: number;
  weeklyQuota: number;
  weeklyUsed: number;
  weeklyRemaining: number;
  overQuota: boolean;
}

export interface TokenLedgerEntry {
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  turnCount: number;
}

const DEFAULT_WEEKLY_QUOTA = 2_000_000;

export class TokenBudgetLedger {
  constructor(
    private readonly pool: DatabasePool,
    private readonly weeklyQuota: number = DEFAULT_WEEKLY_QUOTA,
  ) {}

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS session_token_usage (
        session_id TEXT NOT NULL,
        date DATE NOT NULL DEFAULT CURRENT_DATE,
        input_tokens BIGINT NOT NULL DEFAULT 0,
        output_tokens BIGINT NOT NULL DEFAULT 0,
        turn_count INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (session_id, date)
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_session_token_usage_date ON session_token_usage(date DESC)
    `);
  }

  async recordUsage(entry: TokenLedgerEntry): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO session_token_usage (session_id, date, input_tokens, output_tokens, turn_count)
       VALUES ($1, CURRENT_DATE, $2, $3, $4)
       ON CONFLICT (session_id, date)
       DO UPDATE SET
         input_tokens = session_token_usage.input_tokens + EXCLUDED.input_tokens,
         output_tokens = session_token_usage.output_tokens + EXCLUDED.output_tokens,
         turn_count = session_token_usage.turn_count + EXCLUDED.turn_count,
         updated_at = now()`,
      [entry.sessionId, entry.inputTokens, entry.outputTokens, entry.turnCount],
    );
  }

  async getWeeklyUsage(): Promise<{ totalInputTokens: number; totalOutputTokens: number; totalTokens: number; days: number }> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `SELECT
         COALESCE(SUM(input_tokens), 0) as total_input,
         COALESCE(SUM(output_tokens), 0) as total_output,
         COUNT(DISTINCT date) as days
       FROM session_token_usage
       WHERE date >= CURRENT_DATE - INTERVAL '7 days'`,
    );
    const row = result.rows[0] as Record<string, unknown>;
    const totalInput = Number(row.total_input ?? 0);
    const totalOutput = Number(row.total_output ?? 0);
    return {
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalTokens: totalInput + totalOutput,
      days: Number(row.days ?? 0),
    };
  }

  async getSessionUsage(sessionId: string): Promise<SessionTokenUsage> {
    await this.ensureSchema();
    const sessionResult = await this.pool.query(
      `SELECT
         COALESCE(SUM(input_tokens), 0) as total_input,
         COALESCE(SUM(output_tokens), 0) as total_output,
         COALESCE(SUM(turn_count), 0) as turn_count
       FROM session_token_usage
       WHERE session_id = $1`,
      [sessionId],
    );
    const sessionRow = sessionResult.rows[0] as Record<string, unknown>;
    const totalInput = Number(sessionRow.total_input ?? 0);
    const totalOutput = Number(sessionRow.total_output ?? 0);

    const weekly = await this.getWeeklyUsage();
    return {
      sessionId,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalTokens: totalInput + totalOutput,
      turnCount: Number(sessionRow.turn_count ?? 0),
      weeklyQuota: this.weeklyQuota,
      weeklyUsed: weekly.totalTokens,
      weeklyRemaining: Math.max(0, this.weeklyQuota - weekly.totalTokens),
      overQuota: weekly.totalTokens > this.weeklyQuota,
    };
  }
}

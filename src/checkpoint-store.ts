// Phase 4A — checkpoint persistence layer
// Pure parameterized SQL. PostgreSQL only. No ORM. No SQLite.
import { DatabasePool, DatabaseClient } from './types.js';
import {
  CheckpointRecord, CreateCheckpointInput, StoreRawInput,
  RawCaptureRecord, ExpandedRef, CompactedRef,
} from './checkpoint-types.js';
import type { Redactor } from './redactor.js';

/** Maps a pg row to a CheckpointRecord (JSONB/TEXT[] auto-parsed by node-postgres). */
function rowToCheckpoint(row: any): CheckpointRecord {
  return {
    checkpointId: row.checkpoint_id,
    sessionId: row.session_id,
    projectId: row.project_id ?? undefined,
    createdAt: row.created_at,
    sourceMessageStart: row.source_message_start ?? undefined,
    sourceMessageEnd: row.source_message_end ?? undefined,
    summaryMarkdown: row.summary_markdown,
    summaryTokens: row.summary_tokens,
    inputTokensEstimate: row.input_tokens_estimate,
    sourceRefs: readJsonArray(row.source_refs),
    compactedRefs: readJsonArray(row.compacted_refs),
    filesMentioned: Array.isArray(row.files_mentioned) ? row.files_mentioned : [],
    testsMentioned: Array.isArray(row.tests_mentioned) ? row.tests_mentioned : [],
    risks: readJsonArray(row.risks),
    nextSteps: readJsonArray(row.next_steps),
    supersedesCheckpointId: row.supersedes_checkpoint_id ?? undefined,
    schemaVersion: row.schema_version,
    isActive: row.is_active,
  };
}

function readJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function rowToRawCapture(row: any): RawCaptureRecord {
  return {
    rawId: row.raw_id,
    checkpointId: row.checkpoint_id,
    messageId: row.message_id ?? undefined,
    partId: row.part_id ?? undefined,
    toolCallId: row.tool_call_id ?? undefined,
    kind: row.kind,
    content: row.content,
    tokenCount: row.token_count,
    capturedAt: row.captured_at,
  };
}

/** CRUD for durable checkpoints. All inputs parameterized. */
export class CheckpointStore {
  redactor?: Redactor;
  constructor(private readonly pool: DatabasePool, redactor?: Redactor) {
    this.redactor = redactor;
  }

  /**
   * Atomically: deactivate prior active checkpoints in the session, then insert
   * the new checkpoint with is_active=true and its raw captures. One transaction.
   */
  async createCheckpoint(input: CreateCheckpointInput): Promise<CheckpointRecord> {
    // Phase 18 — Redact before persistence
    const summaryMarkdown = this.redactor
      ? this.redactor.redact(input.summaryMarkdown).text
      : input.summaryMarkdown;
    const rawCaptures = this.redactor
      ? input.rawCaptures.map(rc => ({ ...rc, content: this.redactor!.redact(rc.content).text }))
      : input.rawCaptures;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Deactivate all prior active checkpoints in this session
      const prev = await client.query(
        `UPDATE checkpoints SET is_active = false
         WHERE session_id = $1 AND is_active = true
         RETURNING checkpoint_id`,
        [input.sessionId],
      );
      const prevId = prev.rows.length > 0 ? (prev.rows[0] as { checkpoint_id: string }).checkpoint_id : null;
      // Insert new checkpoint (active)
      const ins = await client.query(
        `INSERT INTO checkpoints
           (session_id, project_id, source_message_start, source_message_end,
            summary_markdown, summary_tokens, input_tokens_estimate,
            source_refs, compacted_refs, files_mentioned, tests_mentioned,
            risks, next_steps, supersedes_checkpoint_id, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true)
         RETURNING *`,
        [
          input.sessionId, input.projectId ?? null,
          input.sourceMessageStart ?? null, input.sourceMessageEnd ?? null,
          summaryMarkdown, input.summaryTokens, input.inputTokensEstimate,
          JSON.stringify(input.sourceRefs), JSON.stringify(input.compactedRefs),
          input.filesMentioned, input.testsMentioned,
          JSON.stringify(input.risks), JSON.stringify(input.nextSteps), prevId,
        ],
      );
      const checkpoint = rowToCheckpoint(ins.rows[0]);
      // Insert raw captures
      for (const rc of rawCaptures) {
        await client.query(
          `INSERT INTO checkpoint_raw_captures
             (checkpoint_id, message_id, part_id, tool_call_id, kind, content, token_count)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [checkpoint.checkpointId, rc.messageId ?? null, rc.partId ?? null,
           rc.toolCallId ?? null, rc.kind, rc.content, rc.tokenCount],
        );
      }
      await client.query('COMMIT');
      return checkpoint;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /** Returns the single active checkpoint for a session, or null. */
  async getActiveCheckpoint(sessionId: string): Promise<CheckpointRecord | null> {
    const res = await this.pool.query(
      `SELECT * FROM checkpoints WHERE session_id = $1 AND is_active = true LIMIT 1`,
      [sessionId],
    );
    return res.rows.length > 0 ? rowToCheckpoint(res.rows[0]) : null;
  }

  /** Lists checkpoints for a session, newest first. */
  async listCheckpoints(sessionId: string, limit = 10): Promise<CheckpointRecord[]> {
    const res = await this.pool.query(
      `SELECT * FROM checkpoints WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [sessionId, limit],
    );
    return res.rows.map(rowToCheckpoint);
  }

  /** Returns raw captures for a checkpoint (recovery data). */
  async getRawCaptures(checkpointId: string): Promise<RawCaptureRecord[]> {
    const res = await this.pool.query(
      `SELECT * FROM checkpoint_raw_captures WHERE checkpoint_id = $1 ORDER BY captured_at ASC`,
      [checkpointId],
    );
    return res.rows.map(rowToRawCapture);
  }

  /**
   * Recovery: find a raw capture by message_id or tool_call_id within the
   * active checkpoint of a session. Returns ExpandedRef with found=false if absent.
   */
  async expandRef(
    sessionId: string,
    identifier: string,
  ): Promise<ExpandedRef> {
    const active = await this.getActiveCheckpoint(sessionId);
    if (!active) {
      return { found: false, error: 'no_active_checkpoint' };
    }
    const res = await this.pool.query(
      `SELECT * FROM checkpoint_raw_captures
       WHERE checkpoint_id = $1 AND (message_id = $2 OR tool_call_id = $2)
       LIMIT 1`,
      [active.checkpointId, identifier],
    );
    if (res.rows.length === 0) {
      return { found: false, error: 'no_capture_for_identifier' };
    }
    return { found: true, rawCapture: rowToRawCapture(res.rows[0]) };
  }
}

import type { DatabasePool } from './types.js';
import type { Redactor } from './redactor.js';
import { getLogger } from './logger.js';
import { dialectFromPool } from './db/query-dialect.js';
import { AgentWorkJournalReader } from './agent-work-journal-reader.js';
import {
  asError,
  extractFilesTouched,
  extractTarget,
  inferToolIntent,
  summarizeResult,
  truncateText,
} from './agent-work-journal-format.js';
import { isMilestoneIntent } from './work-journal-types.js';
import type {
  ResumeEntry,
  ResumePayload,
  WorkJournalConfig,
  WorkJournalEntry,
  WorkJournalEntryType,
} from './work-journal-types.js';

export class AgentWorkJournal {
  private readonly reader: AgentWorkJournalReader;
  private readonly flushIntervalMs = 500;
  private writeBuffer: WorkJournalEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;
  private readonly sessionEndKeys = new Set<string>();
  private currentTokenSnapshot = 0;

  constructor(
    private readonly pool: DatabasePool,
    private readonly config: WorkJournalConfig,
    private readonly redactor?: Redactor,
  ) {
    this.reader = new AgentWorkJournalReader(pool, config);
  }

  recordToolCall(entry: {
    sessionId: string;
    projectId?: string;
    toolName: string;
    args: Record<string, unknown>;
    output: string;
    error?: string;
    exitCode?: number;
    tokenSnapshot?: number;
  }): void {
    if (!this.config.enabled) return;
    const intent = inferToolIntent(entry.toolName, entry.args);
    let entryType: WorkJournalEntryType = 'tool_call';
    if (entry.error || (entry.exitCode !== undefined && entry.exitCode !== 0)) {
      entryType = 'error';
    } else if (this.config.autoMarkMilestone && isMilestoneIntent(intent)) {
      entryType = 'milestone';
    }
    this.bufferEntry({
      sessionId: entry.sessionId,
      projectId: entry.projectId,
      entryType,
      toolName: entry.toolName,
      intent: truncateText(intent, this.config.maxIntentChars),
      target: extractTarget(entry.toolName, entry.args),
      resultSummary: summarizeResult(entry.output, entry.error, entry.exitCode),
      errorSummary: entry.error?.substring(0, 200),
      filesTouched: extractFilesTouched(entry.toolName, entry.args),
      tokenSnapshot: entry.tokenSnapshot ?? this.currentTokenSnapshot,
    });
  }
  recordDecision(entry: {
    sessionId: string;
    projectId?: string;
    intent: string;
    filesTouched?: string[];
    tokenSnapshot?: number;
  }): void {
    if (!this.config.enabled) return;
    this.bufferEntry({
      sessionId: entry.sessionId,
      projectId: entry.projectId,
      entryType: 'decision',
      intent: truncateText(entry.intent, this.config.maxIntentChars),
      filesTouched: entry.filesTouched ?? [],
      tokenSnapshot: entry.tokenSnapshot ?? this.currentTokenSnapshot,
    });
  }
  async recordSessionEnd(
    sessionId: string,
    projectId?: string,
    messageCount?: number,
  ): Promise<void> {
    if (!this.config.enabled || !this.config.persistOnDispose) return;
    const key = `${sessionId}\0${projectId ?? ''}`;
    if (!this.sessionEndKeys.has(key)) {
      this.sessionEndKeys.add(key);
      this.bufferEntry({ sessionId, projectId, entryType: 'session_end',
        intent: `Session ended after ${messageCount ?? '?'} messages`, filesTouched: [],
        tokenSnapshot: this.currentTokenSnapshot });
    }
    await this.flush();
  }
  updateTokenSnapshot(tokens: number): void {
    this.currentTokenSnapshot = tokens;
  }
  async flush(): Promise<void> {
    this.clearFlushTimer();
    if (this.flushPromise) return this.flushPromise;
    if (this.writeBuffer.length === 0) return;
    const operation = this.drainBuffer();
    this.flushPromise = operation;
    try {
      await operation;
    } finally {
      if (this.flushPromise === operation) this.flushPromise = null;
    }
  }
  buildResumePayload(
    sessionId: string,
    projectId: string | undefined,
    activeGoal?: string,
  ): Promise<ResumePayload | null> {
    return this.reader.buildResumePayload(sessionId, projectId, activeGoal);
  }
  getRecentEntries(sessionId: string, limit: number): Promise<ResumeEntry[]> {
    return this.reader.getRecentEntries(sessionId, limit);
  }
  private async drainBuffer(): Promise<void> {
    while (this.writeBuffer.length > 0) {
      const entries = this.writeBuffer.splice(0);
      let inserted = 0;
      try {
        for (const entry of entries) {
          await this.insertEntry(entry);
          inserted += 1;
        }
      } catch (error) {
        const remaining = entries.slice(inserted);
        this.writeBuffer.unshift(...remaining);
        getLogger().error('WorkJournal flush failed', asError(error));
        getLogger().warn(`WorkJournal re-queued ${remaining.length} entries after flush failure`);
        throw error;
      }
    }
  }

  private async insertEntry(entry: WorkJournalEntry): Promise<void> {
    const values = [
      entry.sessionId,
      entry.projectId ?? null,
      entry.entryType,
      entry.toolName ?? null,
      this.redact(entry.intent),
      this.redact(entry.target),
      this.redact(entry.resultSummary),
      this.redact(entry.errorSummary),
      dialectFromPool(this.pool) === 'sqlite'
        ? JSON.stringify(entry.filesTouched) : entry.filesTouched,
      entry.tokenSnapshot ?? null,
    ];
    await this.pool.query(
      `INSERT INTO agent_work_journal
       (session_id, project_id, entry_type, tool_name, intent, target,
        result_summary, error_summary, files_touched, token_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      values,
    );
  }

  private redact(value?: string): string | null {
    if (!value) return null;
    return this.redactor ? this.redactor.redact(value).text : value;
  }

  private bufferEntry(entry: WorkJournalEntry): void {
    this.writeBuffer.push(entry);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.backgroundFlush(), this.flushIntervalMs);
    }
    if (this.writeBuffer.length >= 5) this.backgroundFlush();
  }

  private backgroundFlush(): void {
    this.flush().catch((error) => {
      getLogger().error('WorkJournal background flush failed', asError(error));
    });
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }
}

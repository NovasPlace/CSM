import type { DatabasePool } from './types.js';
import type {
  WorkJournalEntry,
  WorkJournalEntryType,
  WorkJournalConfig,
  ResumeEntry,
  ResumePayload,
} from './work-journal-types.js';
import { inferNextStep, collectAllFiles, isMilestoneIntent } from './work-journal-types.js';
// isErrorResult imported but unused — Phase 3D
import type { Redactor } from './redactor.js';
import { getLogger } from './logger.js';

interface WorkJournalRow {
  entry_type: string;
  tool_name: string | null;
  intent: string | null;
  target: string | null;
  result_summary: string | null;
  error_summary: string | null;
  files_touched: string[] | string;
  created_at: Date;
}

const FILE_ARG_KEYS = ['filePath', 'path', 'pattern', 'command', 'url', 'query'];

export class AgentWorkJournal {
  private writeBuffer: WorkJournalEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> = Promise.resolve();
  private readonly FLUSH_INTERVAL_MS = 500;
  private currentTokenSnapshot: number = 0;

  constructor(
    private readonly pool: DatabasePool,
    private readonly config: WorkJournalConfig,
    private readonly redactor?: Redactor,
  ) {}

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

    const filesTouched = this.extractFilesTouched(entry.toolName, entry.args, entry.output);
    const intent = this.inferToolIntent(entry.toolName, entry.args, entry.output);
    const resultSummary = this.summarizeResult(entry.output, entry.error, entry.exitCode);

    let entryType: WorkJournalEntryType = 'tool_call';
    if (entry.error || (entry.exitCode !== undefined && entry.exitCode !== 0)) {
      entryType = 'error';
    } else if (this.config.autoMarkMilestone && isMilestoneIntent(intent)) {
      entryType = 'milestone';
    }

    const truncatedIntent = intent.length > this.config.maxIntentChars
      ? intent.substring(0, this.config.maxIntentChars) + '...'
      : intent;

    this.bufferEntry({
      sessionId: entry.sessionId,
      projectId: entry.projectId,
      entryType,
      toolName: entry.toolName,
      intent: truncatedIntent,
      target: this.extractTarget(entry.toolName, entry.args),
      resultSummary,
      errorSummary: entry.error ? entry.error.substring(0, 200) : undefined,
      filesTouched,
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

    const truncatedIntent = entry.intent.length > this.config.maxIntentChars
      ? entry.intent.substring(0, this.config.maxIntentChars) + '...'
      : entry.intent;

    this.bufferEntry({
      sessionId: entry.sessionId,
      projectId: entry.projectId,
      entryType: 'decision',
      intent: truncatedIntent,
      filesTouched: entry.filesTouched ?? [],
      tokenSnapshot: entry.tokenSnapshot ?? this.currentTokenSnapshot,
    });
  }

  async recordSessionEnd(sessionId: string, projectId?: string, messageCount?: number): Promise<void> {
    if (!this.config.enabled || !this.config.persistOnDispose) return;

    this.bufferEntry({
      sessionId,
      projectId,
      entryType: 'session_end',
      intent: `Session ended after ${messageCount ?? '?'} messages`,
      filesTouched: [],
      tokenSnapshot: this.currentTokenSnapshot,
    });

    await this.flush();
  }

  updateTokenSnapshot(tokens: number): void {
    this.currentTokenSnapshot = tokens;
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const entries = this.writeBuffer.splice(0);
    if (entries.length === 0) return this.flushPromise;

    this.flushPromise = this.flushPromise.then(async () => {
      getLogger().info(`WorkJournal flushing ${entries.length} entries`);
      try {
      for (const entry of entries) {
        const redactedIntent = this.redactor ? this.redactor.redact(entry.intent).text : entry.intent;
        const redactedTarget = entry.target
          ? (this.redactor ? this.redactor.redact(entry.target).text : entry.target)
          : null;
        const redactedResult = entry.resultSummary
          ? (this.redactor ? this.redactor.redact(entry.resultSummary).text : entry.resultSummary)
          : null;
        const redactedError = entry.errorSummary
          ? (this.redactor ? this.redactor.redact(entry.errorSummary).text : entry.errorSummary)
          : null;

        const _result = await this.pool.query(
          `INSERT INTO agent_work_journal
           (session_id, project_id, entry_type, tool_name, intent, target,
            result_summary, error_summary, files_touched, token_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            entry.sessionId,
            entry.projectId ?? null,
            entry.entryType,
            entry.toolName ?? null,
            redactedIntent,
            redactedTarget,
            redactedResult,
            redactedError,
            entry.filesTouched,
            entry.tokenSnapshot ?? null,
          ],
         );
         getLogger().info(`WorkJournal inserted entry: ${entry.toolName || 'unknown'} (${entry.entryType})`);
      }
      } catch (e) {
        getLogger().error('WorkJournal flush failed', e instanceof Error ? e : undefined);
      }
    });
    return this.flushPromise;
  }

  async buildResumePayload(
    sessionId: string,
    projectId: string | undefined,
    activeGoal?: string,
  ): Promise<ResumePayload | null> {
    try {
      const lastSessionResult = await this.pool.query(
        `SELECT DISTINCT session_id FROM agent_work_journal
         WHERE project_id = $1 AND session_id != $2
         ORDER BY session_id DESC
         LIMIT 1`,
        [projectId ?? null, sessionId],
      );

      let fromSessionId: string;
      if (lastSessionResult.rows.length === 0) {
        const fallbackResult = await this.pool.query(
          `SELECT DISTINCT session_id FROM agent_work_journal
           WHERE session_id != $1
           ORDER BY session_id DESC
           LIMIT 1`,
          [sessionId],
        );
        if (fallbackResult.rows.length === 0) return null;

        fromSessionId = (fallbackResult.rows[0] as { session_id: string }).session_id;
      } else {
        fromSessionId = (lastSessionResult.rows[0] as { session_id: string }).session_id;
      }

      const entriesResult = await this.pool.query(
        `SELECT * FROM agent_work_journal
         WHERE session_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [fromSessionId, this.config.maxResumeEntries],
      );

      if (entriesResult.rows.length === 0) return null;

      const entries: ResumeEntry[] = (entriesResult.rows as WorkJournalRow[]).map((row) => ({
        entryType: row.entry_type as WorkJournalEntryType,
        toolName: row.tool_name ?? undefined,
        intent: row.intent ?? '',
        target: row.target ?? undefined,
        resultSummary: row.result_summary ?? undefined,
        errorSummary: row.error_summary ?? undefined,
        filesTouched: Array.isArray(row.files_touched) ? row.files_touched : [],
        createdAt: row.created_at as Date,
      }));

      const countResult = await this.pool.query(
        `SELECT COUNT(*) as cnt FROM agent_work_journal WHERE session_id = $1`,
        [fromSessionId],
      );
      const totalEntries = parseInt((countResult.rows[0] as { cnt: string }).cnt, 10);
      const lastActiveAt = (entriesResult.rows[0] as { created_at: Date }).created_at;

      const nextStepInferred = inferNextStep(entries);
      const allFilesTouched = collectAllFiles(entries);
      const tokenCount = Math.ceil(
        entries.reduce((sum, e) => sum + e.intent.length + (e.resultSummary?.length ?? 0) + (e.errorSummary?.length ?? 0), 0) / 4,
      );

      return {
        fromSessionId,
        fromProjectId: projectId,
        lastActiveAt,
        totalEntries,
        entries,
        activeGoal,
        nextStepInferred,
        allFilesTouched,
         tokenCount,
       };
     } catch (e) {
       getLogger().error('WorkJournal resume payload build failed', e instanceof Error ? e : undefined);
       return null;
     }
  }

  async getRecentEntries(sessionId: string, limit: number): Promise<ResumeEntry[]> {
    try {
      const result = await this.pool.query(
        `SELECT * FROM agent_work_journal
         WHERE session_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [sessionId, limit],
      );
      return (result.rows as WorkJournalRow[]).map((row) => ({
        entryType: row.entry_type as WorkJournalEntryType,
        toolName: row.tool_name ?? undefined,
        intent: row.intent ?? '',
        target: row.target ?? undefined,
        resultSummary: row.result_summary ?? undefined,
        errorSummary: row.error_summary ?? undefined,
        filesTouched: Array.isArray(row.files_touched) ? row.files_touched : [],
        createdAt: row.created_at as Date,
      }));
    } catch {
      return [];
    }
  }

  private bufferEntry(entry: WorkJournalEntry): void {
    this.writeBuffer.push(entry);

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush().catch(() => {});
      }, this.FLUSH_INTERVAL_MS);
    }

    if (this.writeBuffer.length >= 5) {
      this.flush().catch(() => {});
    }
  }

  private inferToolIntent(toolName: string, args: Record<string, unknown>, _output: string): string {
    switch (toolName) {
      case 'read':
        return `Read ${args.filePath ?? args.path ?? 'file'}`;
      case 'write':
        return `Write ${args.filePath ?? args.path ?? 'file'}`;
      case 'edit':
        return `Edit ${args.filePath ?? args.path ?? 'file'}`;
      case 'grep':
        return `Search for "${args.pattern ?? '?'}" in ${args.include ?? 'files'}`;
      case 'glob':
        return `Find files matching "${args.pattern ?? '?'}"`;
      case 'bash':
        return `Run: ${(args.command as string ?? '?').substring(0, 120)}`;
      case 'task':
        return `Launch subagent: ${(args.description as string ?? args.prompt as string ?? '?').substring(0, 80)}`;
      case 'csm_memory_save':
        return `Save memory: ${(args.content as string ?? '?').substring(0, 80)}`;
      case 'csm_memory_search':
        return `Search memories: "${args.query ?? '?'}"`;
      case 'csm_memory_lesson':
        return `Save lesson: ${(args.content as string ?? '?').substring(0, 80)}`;
      case 'create_checkpoint':
        return 'Create checkpoint';
      default:
        return `${toolName}: ${JSON.stringify(args).substring(0, 100)}`;
    }
  }

  private extractTarget(toolName: string, args: Record<string, unknown>): string | undefined {
    if (toolName === 'bash' && args.command) {
      return (args.command as string).substring(0, 200);
    }
    for (const key of FILE_ARG_KEYS) {
      if (args[key] && typeof args[key] === 'string') {
        return args[key] as string;
      }
    }
    return undefined;
  }

  private extractFilesTouched(toolName: string, args: Record<string, unknown>, _output: string): string[] {
    const files: string[] = [];
    if (['read', 'write', 'edit'].includes(toolName)) {
      const filePath = (args.filePath ?? args.path) as string | undefined;
      if (filePath) files.push(filePath);
    }
    if (toolName === 'glob' || toolName === 'grep') {
      const pattern = (args.pattern ?? args.include) as string | undefined;
      if (pattern) files.push(`search:${pattern}`);
    }
    return files;
  }

  private summarizeResult(output: string, error?: string, exitCode?: number): string | undefined {
    if (error) {
      return `Error: ${error.substring(0, 150)}`;
    }
    if (exitCode !== undefined && exitCode !== 0) {
      return `Exit code ${exitCode}: ${output.substring(0, 100)}`;
    }
    if (!output || output.length === 0) return undefined;
    if (output.length <= 150) return output;

    const firstLine = output.split('\n')[0] ?? '';
    if (firstLine.length <= 150) return firstLine;
    return output.substring(0, 150) + '...';
  }
}

import type { ContextBrief, Memory } from './types.js';
import { Database } from './database.js';
import { recordRecallBatch } from './recall-telemetry.js';
import { getLogger } from './logger.js';
import { ContextRecallSelector } from './context-recall-selector.js';
import { formatContextBrief } from './context-recall-format.js';
import {
  persistBrief,
  readCachedBrief,
  readDistilledGroups,
} from './context-recall-persistence.js';

export class ContextRecallDaemon {
  private readonly database: Database;
  private readonly interval: number;
  private readonly selector: ContextRecallSelector;
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentSessionId: string | null = null;
  private currentProjectId: string | null = null;

  constructor(database: Database, interval = 90) {
    this.database = database;
    this.interval = interval * 1000;
    this.selector = new ContextRecallSelector(database.getPool());
  }

  start(): void {
    if (!this.supportsPersistentBriefs()) {
      getLogger().info('ContextRecallDaemon disabled for SQLite MVP');
      return;
    }
    if (this.timer) return;
    getLogger().info(`ContextRecallDaemon starting (interval: ${this.interval / 1000}s)`);
    this.buildContext().catch((error) => this.logBuildFailure('initial', error));
    this.timer = setInterval(() => {
      this.buildContext().catch((error) => this.logBuildFailure('periodic', error));
    }, this.interval);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    getLogger().info('ContextRecallDaemon stopped');
  }

  setSession(sessionId: string, projectId: string): void {
    this.currentSessionId = sessionId;
    this.currentProjectId = projectId;
    this.selector.setProject(projectId);
  }

  async refreshSession(sessionId: string, projectId: string): Promise<ContextBrief> {
    this.setSession(sessionId, projectId);
    return this.buildContext();
  }

  async getContextBrief(): Promise<ContextBrief | null> {
    if (!this.supportsPersistentBriefs() || !this.currentSessionId) return null;
    const cached = await readCachedBrief(this.database.getPool(), this.currentSessionId);
    return cached ?? this.buildContext();
  }

  async buildContext(): Promise<ContextBrief> {
    if (!this.supportsPersistentBriefs()) return emptyBrief();
    const pool = this.database.getPool();
    const [episodic, procedural, semantic, distilled] = await Promise.all([
      this.selector.episodic(),
      this.selector.procedural(),
      this.selector.semantic(),
      readDistilledGroups(pool, this.currentSessionId),
    ]);
    const compressed = formatContextBrief(episodic, procedural, semantic, distilled);
    const brief = { episodic, procedural, semantic, distilled, compressed };
    if (this.currentSessionId) {
      await persistBrief(pool, this.currentSessionId, this.currentProjectId, brief);
      await this.logContextRecall([...episodic, ...procedural, ...semantic]);
    }
    return brief;
  }

  private supportsPersistentBriefs(): boolean {
    return this.database.dialect === 'pg';
  }

  private logBuildFailure(stage: string, error: unknown): void {
    getLogger().error(
      `ContextRecallDaemon ${stage} build failed`,
      error instanceof Error ? error : undefined,
    );
  }

  private async logContextRecall(memories: Memory[]): Promise<void> {
    if (!this.currentSessionId || memories.length === 0) return;
    try {
      await recordRecallBatch(
        this.database.getPool(),
        memories.map((memory, index) => this.recallEvent(memory, index)),
      );
    } catch (error) {
      getLogger().error('Recall telemetry write failed', error instanceof Error ? error : undefined);
    }
  }

  private recallEvent(memory: Memory, index: number) {
    return {
      memoryId: memory.id,
      sessionId: this.currentSessionId,
      projectId: memory.projectId ?? this.currentProjectId,
      query: `context:${this.currentProjectId ?? 'global'}`,
      source: 'context_recall' as const,
      rank: index + 1,
      score: memory.importance,
    };
  }
}

function emptyBrief(): ContextBrief {
  return { episodic: [], procedural: [], semantic: [], distilled: [], compressed: '' };
}

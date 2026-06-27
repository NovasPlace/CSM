import { createHash } from 'node:crypto';
import { ContextCompactor } from './context-compactor.js';
import { ContextRecallDaemon } from './context-recall.js';
import { Database } from './database.js';
import { EmbeddingGenerator } from './embeddings.js';
import { DEFAULT_CONFIG } from './config.js';
import { MemoryManager } from './memory-manager.js';
import { PrimingEngine } from './priming-engine.js';
import { Redactor } from './redactor.js';
import {
  backfillMissingEmbeddingsOp,
  getCompactionReportOp,
  getContextBriefOp,
  listMemoriesOp,
  pruneMemoriesDryRunOp,
  recallLessonsOp,
  saveMemoryOp,
  searchMemoriesOp,
  type BridgeDeps,
  type CompactionReportPayload,
  type ContextBriefPayload,
} from './bridge-ops.js';
import type { Memory, MemoryListOptions, MemorySaveOptions, MemorySearchOptions, PluginConfig, PruneReport } from './types.js';

export class CodexMemoryBridge {
  private readonly deps: BridgeDeps;

  private constructor(
    private readonly config: PluginConfig,
    deps: BridgeDeps,
  ) {
    this.deps = deps;
  }

  static async connect(config: Partial<PluginConfig> = {}): Promise<CodexMemoryBridge> {
    const merged = { ...DEFAULT_CONFIG, ...config };
    const database = new Database(merged);
    await database.connect();
    const redactor = new Redactor(merged.redactor);
    const embeddings = new EmbeddingGenerator(merged);
    return new CodexMemoryBridge(merged, {
      database,
      memoryManager: new MemoryManager(database, embeddings, redactor),
      contextRecall: new ContextRecallDaemon(database, merged.contextRecallInterval),
      primingEngine: new PrimingEngine(database),
      contextCompactor: new ContextCompactor(merged.compactor),
    });
  }

  async disconnect(): Promise<void> {
    await this.deps.database?.close();
  }

  async saveMemory(input: MemorySaveOptions & { projectRoot?: string; sessionId?: string }): Promise<Memory> {
    const sessionId = await this.ensureSession(input.projectRoot, input.sessionId);
    return saveMemoryOp(this.deps, { ...input, sessionId });
  }

  async searchMemories(input: MemorySearchOptions & { sessionId?: string }): Promise<Awaited<ReturnType<typeof searchMemoriesOp>>> {
    return searchMemoriesOp(this.deps, input, { projectId: input.projectId, sessionId: input.sessionId });
  }

  async listMemories(input: MemoryListOptions & { sessionId?: string }): Promise<Memory[]> {
    return listMemoriesOp(this.deps, input, { projectId: input.projectId, sessionId: input.sessionId });
  }

  async getContextBrief(input: { projectRoot: string; task: string; sessionId?: string }): Promise<ContextBriefPayload> {
    const sessionId = await this.ensureSession(input.projectRoot, input.sessionId);
    if (!sessionId) {
      throw new Error('Bridge session is required for getContextBrief');
    }
    await this.deps.contextRecall.refreshSession(sessionId, input.projectRoot);
    return getContextBriefOp(this.deps, input.task, { projectId: input.projectRoot, sessionId });
  }

  async recallLessons(input: { projectRoot?: string; task: string; sessionId?: string; limit?: number }): Promise<Memory[]> {
    return recallLessonsOp(
      this.deps,
      input.task,
      { projectId: input.projectRoot, sessionId: input.sessionId },
      input.limit ?? 5,
    );
  }

  async pruneMemoriesDryRun(): Promise<PruneReport> {
    return pruneMemoriesDryRunOp(this.deps);
  }

  async backfillMissingEmbeddings(input: { limit: number; projectId?: string; dryRun?: boolean }) {
    return backfillMissingEmbeddingsOp(this.deps, input.limit, input.projectId, input.dryRun);
  }

  async getCompactionReport(sessionId?: string): Promise<CompactionReportPayload> {
    return getCompactionReportOp(this.deps, sessionId);
  }

  listTools(): string[] {
    return [
      'save_memory',
      'search_memories',
      'list_memories',
      'get_context_brief',
      'recall_lessons',
      'prune_memories_dry_run',
      'backfill_missing_embeddings',
      'get_compaction_report',
    ];
  }

  getDatabaseUrl(): string {
    return this.config.databaseUrl;
  }

  private async ensureSession(projectRoot?: string, sessionId?: string): Promise<string | undefined> {
    if (!projectRoot && !sessionId) return undefined;
    const resolvedProject = projectRoot ?? 'codex-bridge';
    const resolvedSession = sessionId ?? this.defaultSessionId(resolvedProject);
    await this.deps.memoryManager.createSession(resolvedSession, resolvedProject);
    this.deps.contextRecall.setSession(resolvedSession, resolvedProject);
    return resolvedSession;
  }

  private defaultSessionId(projectRoot: string): string {
    const hash = createHash('sha1').update(projectRoot).digest('hex').slice(0, 12);
    return `codex-${hash}`;
  }
}

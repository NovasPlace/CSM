import { createHash } from 'node:crypto';
import { ContextCompactor } from './context-compactor.js';
import { ContextRecallDaemon } from './context-recall.js';
import { Database } from './database.js';
import { EmbeddingGenerator } from './embeddings.js';
import { DEFAULT_CONFIG } from './config.js';
import { CheckpointStore } from './checkpoint-store.js';
import { MemoryExtractor } from './memory-extractor.js';
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
import { previewTeacherTracesOp, seedTeacherTracesOp } from './teacher-trace-ops.js';
import type { TeacherTraceSeedResult } from './teacher-trace-types.js';
import { captureTraceVaultOp, previewTraceVaultOp, seedTeacherTracesFromVaultOp } from './trace-vault-ops.js';
import type { TraceVaultCaptureResult } from './trace-vault-types.js';
import {
  handoffSummaryOp,
  resumeContextOp,
  syncTurnOp,
  type HandoffSummaryPayload,
  type ResumeContextPayload,
  type SyncTurnPayload,
} from './codex-bridge-workflow.js';
import { EXTRA_BRIDGE_TOOL_NAMES, invokeCodexBridgeExtra, type CodexBridgeExtraDeps } from './codex-bridge-extra-ops.js';
import type { Memory, MemoryListOptions, MemorySaveOptions, MemorySearchOptions, PluginConfig, PruneReport } from './types.js';

export class CodexMemoryBridge {
  private readonly deps: BridgeDeps & CodexBridgeExtraDeps;

  private constructor(
    private readonly config: PluginConfig,
    deps: BridgeDeps & CodexBridgeExtraDeps,
  ) {
    this.deps = deps;
  }

  static async connect(config: Partial<PluginConfig> = {}): Promise<CodexMemoryBridge> {
    const merged = { ...DEFAULT_CONFIG, ...config };
    const database = new Database(merged);
    await database.connect();
    const redactor = new Redactor(merged.redactor);
    const embeddings = new EmbeddingGenerator(merged);
    const memoryManager = new MemoryManager(database, embeddings, redactor);
    return new CodexMemoryBridge(merged, {
      database,
      memoryManager,
      contextRecall: new ContextRecallDaemon(database, merged.contextRecallInterval),
      primingEngine: new PrimingEngine(database),
      contextCompactor: new ContextCompactor(merged.compactor),
      memoryExtractor: new MemoryExtractor(database, memoryManager, merged.extractor),
      checkpointStore: new CheckpointStore(database.getPool(), redactor),
      checkpointConfig: merged.checkpoint,
      distillerConfig: merged.distiller,
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

  async previewTeacherTraces(input: { projectRoot?: string; sessionId: string; limit?: number }): Promise<TeacherTraceSeedResult> { await this.ensureSession(input.projectRoot, input.sessionId); return previewTeacherTracesOp(this.deps, { projectId: input.projectRoot, sessionId: input.sessionId, limit: input.limit }); }

  async seedTeacherTraces(input: { projectRoot?: string; sessionId: string; limit?: number }): Promise<TeacherTraceSeedResult> { await this.ensureSession(input.projectRoot, input.sessionId); return seedTeacherTracesOp(this.deps, { projectId: input.projectRoot, sessionId: input.sessionId, limit: input.limit }); }

  async captureTraceVault(input: { projectRoot?: string; sessionId: string; sourceLabel?: string }): Promise<TraceVaultCaptureResult> { await this.ensureSession(input.projectRoot, input.sessionId); return captureTraceVaultOp(this.deps, { sessionId: input.sessionId, projectId: input.projectRoot, sourceLabel: input.sourceLabel ?? 'work_journal' }); }

  async previewTraceVault(input: { projectRoot?: string; sessionId: string; limit?: number }): Promise<TraceVaultCaptureResult[]> { await this.ensureSession(input.projectRoot, input.sessionId); return previewTraceVaultOp(this.deps, input.sessionId, input.limit); }

  async seedTeacherTracesFromVault(input: { projectRoot?: string; sessionId: string; limit?: number }): Promise<{ seeded: number; vault: TraceVaultCaptureResult[] }> { await this.ensureSession(input.projectRoot, input.sessionId); return seedTeacherTracesFromVaultOp(this.deps, this.deps.memoryManager, input.sessionId, input.limit); }

  async resumeContext(input: { projectRoot: string; task: string; sessionId?: string; recentLimit?: number }): Promise<ResumeContextPayload> {
    const sessionId = await this.ensureSession(input.projectRoot, input.sessionId);
    if (!sessionId) {
      throw new Error('Bridge session is required for resumeContext');
    }
    return resumeContextOp(this.deps, { ...input, sessionId });
  }

  async syncTurn(input: { projectRoot?: string; sessionId?: string; role: 'user' | 'assistant' | 'system'; content: string; tags?: string[]; metadata?: Record<string, unknown>; memoryType?: MemorySaveOptions['type'] }): Promise<SyncTurnPayload> {
    const sessionId = await this.ensureSession(input.projectRoot, input.sessionId);
    if (!sessionId) {
      throw new Error('Bridge session is required for syncTurn');
    }
    return syncTurnOp(this.deps, {
      projectRoot: input.projectRoot ?? 'codex-bridge',
      sessionId,
      role: input.role,
      content: input.content,
      tags: input.tags,
      metadata: input.metadata,
      memoryType: input.memoryType,
    });
  }

  async getHandoffSummary(input: { projectRoot: string; task?: string; sessionId?: string; recentLimit?: number }): Promise<HandoffSummaryPayload> {
    const sessionId = await this.ensureSession(input.projectRoot, input.sessionId);
    if (!sessionId) {
      throw new Error('Bridge session is required for getHandoffSummary');
    }
    return handoffSummaryOp(this.deps, {
      projectRoot: input.projectRoot,
      task: input.task ?? 'handoff summary',
      sessionId,
      recentLimit: input.recentLimit,
    });
  }

  async invokeExtra(name: string, input: Record<string, unknown>): Promise<unknown> { const sessionless = new Set(['memory_project_list', 'memory_cleanup', 'csm_runtime_status', 'csm_compaction_audit', 'csm_context_budget']); const sessionId = sessionless.has(name) ? undefined : await this.ensureSession(input.projectRoot as string | undefined, input.sessionId as string | undefined); return invokeCodexBridgeExtra(this.deps, name as never, input, sessionId); }

  listTools(): string[] { return ['save_memory', 'search_memories', 'list_memories', 'get_context_brief', 'recall_lessons', 'bridge_resume_context', 'bridge_sync_turn', 'bridge_handoff_summary', 'prune_memories_dry_run', 'backfill_missing_embeddings', 'get_compaction_report', 'preview_teacher_traces', 'seed_teacher_traces', 'capture_trace_vault', 'preview_trace_vault', 'seed_teacher_traces_from_vault', ...EXTRA_BRIDGE_TOOL_NAMES]; }

  getDatabaseUrl(): string {
    return this.config.databaseUrl;
  }

  private async ensureSession(projectRoot?: string, sessionId?: string): Promise<string | undefined> {
    if (!projectRoot && !sessionId) return undefined;
    const resolvedProject = projectRoot ?? 'codex-bridge';
    const resolvedSession = sessionId ?? this.defaultSessionId(resolvedProject);
    await this.deps.memoryManager.createSession(resolvedSession, resolvedProject);
    this.deps.contextRecall.setSession(resolvedSession, resolvedProject);
    await this.deps.memoryManager.upsertProjectScope(resolvedProject, resolvedProject, resolvedProject);
    return resolvedSession;
  }

  private defaultSessionId(projectRoot: string): string {
    const hash = createHash('sha1').update(projectRoot).digest('hex').slice(0, 12);
    return `codex-${hash}`;
  }
}

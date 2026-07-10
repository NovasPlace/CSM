import { createHash } from 'node:crypto';
import { ContextCompactor } from './context-compactor.js';
import { ContextRecallDaemon } from './context-recall.js';
import { Database } from './database.js';
import { EmbeddingGenerator } from './embeddings.js';
import { DEFAULT_CONFIG, validatePluginConfig } from './config.js';
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
import { withBridgeProvenance } from './bridge-provenance.js';
import {
  handoffSummaryOp,
  resumeContextOp,
  syncTurnOp,
  type HandoffSummaryPayload,
  type ResumeContextPayload,
  type SyncTurnPayload,
} from './codex-bridge-workflow.js';
import { invokeCodexBridgeExtra, type CodexBridgeExtraDeps } from './codex-bridge-extra-ops.js';
import {
  assertBridgeExtraSupported,
  assertFullBridgeRuntime,
  assertWorkLedgerAvailable,
  bridgeToolNames,
} from './codex-bridge-capabilities.js';
import { mergePluginConfig, normalizeProviderRuntimeConfig } from './provider-runtime-config.js';
import type { Memory, MemoryListOptions, MemorySaveOptions, MemorySearchOptions, PluginConfig, PruneReport } from './types.js';
import { WorkLedger } from './work-ledger.js';
import type { WorkLedgerCaptureInput, WorkLedgerChange } from './work-ledger-types.js';

export class CodexMemoryBridge {
  private readonly deps: BridgeDeps & CodexBridgeExtraDeps;

  private constructor(
    private readonly config: PluginConfig,
    deps: BridgeDeps & CodexBridgeExtraDeps,
    private readonly workLedger?: WorkLedger,
  ) {
    this.deps = deps;
  }

  static async connect(config: Partial<PluginConfig> = {}): Promise<CodexMemoryBridge> {
    const configured = mergePluginConfig(DEFAULT_CONFIG, config as unknown as Record<string, unknown>);
    const merged = normalizeProviderRuntimeConfig(validatePluginConfig(configured));
    const database = new Database(merged);
    await database.connect();
    const redactor = new Redactor(merged.redactor);
    const embeddings = new EmbeddingGenerator(merged);
    const memoryManager = new MemoryManager(database, embeddings, redactor);
    const deps = {
      database,
      memoryManager,
      contextRecall: new ContextRecallDaemon(database, merged.contextRecallInterval),
      primingEngine: new PrimingEngine(database),
      contextCompactor: new ContextCompactor(merged.compactor),
      memoryExtractor: new MemoryExtractor(database, memoryManager, merged.extractor),
      checkpointStore: new CheckpointStore(database.getPool(), redactor),
      checkpointConfig: merged.checkpoint,
      distillerConfig: merged.distiller,
    };
    return new CodexMemoryBridge(
      merged,
      deps,
      merged.workLedger.enabled
        ? new WorkLedger(database.getPool(), merged.workLedger)
        : undefined,
    );
  }

  async disconnect(): Promise<void> {
    await this.workLedger?.dispose();
    await this.deps.database?.close();
  }

  async saveMemory(input: MemorySaveOptions & { projectRoot?: string; sessionId?: string }): Promise<Memory> {
    const sessionId = await this.ensureSession(input.projectRoot, input.sessionId);
    return saveMemoryOp(
      this.deps,
      withBridgeProvenance(
        { ...input, sessionId, projectId: input.projectId ?? input.projectRoot },
        { sessionId, projectRoot: input.projectRoot, sourceKind: 'user_supplied' },
      ),
    );
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
    assertFullBridgeRuntime(this.config.databaseProvider, 'prune_memories_dry_run');
    return pruneMemoriesDryRunOp(this.deps);
  }

  async backfillMissingEmbeddings(input: { limit: number; projectId?: string; dryRun?: boolean }) {
    assertFullBridgeRuntime(this.config.databaseProvider, 'backfill_missing_embeddings');
    return backfillMissingEmbeddingsOp(this.deps, input.limit, input.projectId, input.dryRun);
  }

  async getCompactionReport(sessionId?: string): Promise<CompactionReportPayload> {
    assertFullBridgeRuntime(this.config.databaseProvider, 'get_compaction_report');
    return getCompactionReportOp(this.deps, sessionId);
  }

  async previewTeacherTraces(input: { projectRoot?: string; sessionId: string; limit?: number }): Promise<TeacherTraceSeedResult> { assertFullBridgeRuntime(this.config.databaseProvider, 'preview_teacher_traces'); await this.ensureSession(input.projectRoot, input.sessionId); return previewTeacherTracesOp(this.deps, { projectId: input.projectRoot, sessionId: input.sessionId, limit: input.limit }); }

  async seedTeacherTraces(input: { projectRoot?: string; sessionId: string; limit?: number }): Promise<TeacherTraceSeedResult> { assertFullBridgeRuntime(this.config.databaseProvider, 'seed_teacher_traces'); await this.ensureSession(input.projectRoot, input.sessionId); return seedTeacherTracesOp(this.deps, { projectId: input.projectRoot, sessionId: input.sessionId, limit: input.limit }); }

  async captureTraceVault(input: { projectRoot?: string; sessionId: string; sourceLabel?: string }): Promise<TraceVaultCaptureResult> { assertFullBridgeRuntime(this.config.databaseProvider, 'capture_trace_vault'); await this.ensureSession(input.projectRoot, input.sessionId); return captureTraceVaultOp(this.deps, { sessionId: input.sessionId, projectId: input.projectRoot, sourceLabel: input.sourceLabel ?? 'work_journal' }); }

  async previewTraceVault(input: { projectRoot?: string; sessionId: string; limit?: number }): Promise<TraceVaultCaptureResult[]> { assertFullBridgeRuntime(this.config.databaseProvider, 'preview_trace_vault'); await this.ensureSession(input.projectRoot, input.sessionId); return previewTraceVaultOp(this.deps, input.sessionId, input.limit); }

  async seedTeacherTracesFromVault(input: { projectRoot?: string; sessionId: string; limit?: number }): Promise<{ seeded: number; vault: TraceVaultCaptureResult[] }> { assertFullBridgeRuntime(this.config.databaseProvider, 'seed_teacher_traces_from_vault'); await this.ensureSession(input.projectRoot, input.sessionId); return seedTeacherTracesFromVaultOp(this.deps, this.deps.memoryManager, input.sessionId, input.limit); }

  async resumeContext(input: { projectRoot: string; task: string; sessionId?: string; recentLimit?: number }): Promise<ResumeContextPayload> {
    assertFullBridgeRuntime(this.config.databaseProvider, 'bridge_resume_context');
    const sessionId = await this.ensureSession(input.projectRoot, input.sessionId);
    if (!sessionId) {
      throw new Error('Bridge session is required for resumeContext');
    }
    return resumeContextOp(this.deps, { ...input, sessionId });
  }

  async syncTurn(input: { projectRoot?: string; sessionId?: string; role: 'user' | 'assistant' | 'system'; content: string; tags?: string[]; metadata?: Record<string, unknown>; memoryType?: MemorySaveOptions['type'] }): Promise<SyncTurnPayload> {
    assertFullBridgeRuntime(this.config.databaseProvider, 'bridge_sync_turn');
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
    assertFullBridgeRuntime(this.config.databaseProvider, 'bridge_handoff_summary');
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

  async beginWorkChange(input: WorkLedgerCaptureInput): Promise<void> {
    const ledger = this.requireWorkLedger('work_ledger_begin');
    const sessionId = await this.ensureSession(input.projectRoot, input.sessionId);
    await ledger.captureBefore({ ...input, sessionId });
  }

  async completeWorkChange(input: WorkLedgerCaptureInput): Promise<WorkLedgerChange[]> {
    const ledger = this.requireWorkLedger('work_ledger_complete');
    const sessionId = await this.ensureSession(input.projectRoot, input.sessionId);
    return ledger.captureAfter({ ...input, sessionId });
  }

  async getSurvivingWorkChanges(input: {
    runId: string;
    projectRoot?: string;
  }): Promise<WorkLedgerChange[]> {
    const ledger = this.requireWorkLedger('work_ledger_surviving');
    return ledger.listSurvivingChanges(input.runId, input.projectRoot);
  }

  async correlateWorkChangesToCommit(input: {
    changeIds: string[];
    commitSha: string;
  }): Promise<number> {
    const ledger = this.requireWorkLedger('work_ledger_commit');
    return ledger.correlateCommit(input.changeIds, input.commitSha);
  }

  async invokeExtra(name: string, input: Record<string, unknown>): Promise<unknown> { assertBridgeExtraSupported(this.config.databaseProvider, name); const sessionless = new Set(['memory_project_list', 'memory_cleanup', 'csm_runtime_status', 'csm_compaction_audit', 'csm_context_budget']); const sessionId = sessionless.has(name) ? undefined : await this.ensureSession(input.projectRoot as string | undefined, input.sessionId as string | undefined); return invokeCodexBridgeExtra(this.deps, name as never, input, sessionId); }

  listTools(): string[] {
    return bridgeToolNames(this.config.databaseProvider, this.config.workLedger.enabled);
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
    await this.deps.memoryManager.upsertProjectScope(resolvedProject, resolvedProject, resolvedProject);
    return resolvedSession;
  }

  private defaultSessionId(projectRoot: string): string {
    const hash = createHash('sha1').update(projectRoot).digest('hex').slice(0, 12);
    return `codex-${hash}`;
  }

  private requireWorkLedger(operation: string): WorkLedger {
    assertWorkLedgerAvailable(
      this.config.databaseProvider,
      this.config.workLedger.enabled,
      operation,
    );
    if (!this.workLedger) throw new Error(`${operation} Work Ledger runtime is unavailable.`);
    return this.workLedger;
  }
}

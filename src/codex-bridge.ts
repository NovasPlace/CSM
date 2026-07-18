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
  bridgeToolNames,
} from './codex-bridge-capabilities.js';
import type { Memory, MemoryListOptions, MemorySaveOptions, MemorySearchOptions, PluginConfig, PruneReport } from './types.js';
import { WorkLedger } from './work-ledger.js';
import type { WorkLedgerCaptureInput, WorkLedgerChange } from './work-ledger-types.js';
import { CodexBridgeLifecycle } from './codex-bridge-lifecycle.js';
import { CodexBridgeLedgerApi } from './codex-bridge-ledger-api.js';
import { createCodexBridgeRuntime } from './codex-bridge-runtime.js';
import { CodexBridgeSessionApi } from './codex-bridge-session-api.js';

export class CodexMemoryBridge {
  private readonly deps: BridgeDeps & CodexBridgeExtraDeps;
  private readonly lifecycle: CodexBridgeLifecycle;
  private readonly ledgerApi: CodexBridgeLedgerApi;
  private readonly sessionApi: CodexBridgeSessionApi;

  private constructor(
    private readonly config: PluginConfig,
    deps: BridgeDeps & CodexBridgeExtraDeps,
    private readonly workLedger?: WorkLedger,
  ) {
    this.deps = deps;
    this.lifecycle = new CodexBridgeLifecycle(deps.database, workLedger);
    this.sessionApi = new CodexBridgeSessionApi(deps);
    this.ledgerApi = new CodexBridgeLedgerApi(
      config, workLedger, (root, session) => this.sessionApi.ensure(root, session), this.lifecycle,
    );
  }

  static async connect(config: Partial<PluginConfig> = {}): Promise<CodexMemoryBridge> {
    return createCodexBridgeRuntime(config, {
      activate: (runtime) => new CodexMemoryBridge(
        runtime.config, runtime.deps, runtime.workLedger,
      ),
    });
  }
  async disconnect(): Promise<void> {
    await this.lifecycle.disconnect();
  }
  async saveMemory(input: MemorySaveOptions & { projectRoot?: string; sessionId?: string }): Promise<Memory> {
    return this.lifecycle.run(async () => {
      const sessionId = await this.sessionApi.ensure(input.projectRoot, input.sessionId);
      return saveMemoryOp(this.deps, withBridgeProvenance(
        { ...input, sessionId, projectId: input.projectId ?? input.projectRoot },
        { sessionId, projectRoot: input.projectRoot, sourceKind: 'user_supplied' },
      ));
    });
  }
  async searchMemories(input: MemorySearchOptions & { sessionId?: string }): Promise<Awaited<ReturnType<typeof searchMemoriesOp>>> {
    return this.lifecycle.run(() => searchMemoriesOp(this.deps, input, { projectId: input.projectId, sessionId: input.sessionId }));
  }
  async listMemories(input: MemoryListOptions & { sessionId?: string }): Promise<Memory[]> {
    return this.lifecycle.run(() => listMemoriesOp(this.deps, input, { projectId: input.projectId, sessionId: input.sessionId }));
  }
  async getContextBrief(input: { projectRoot: string; task: string; sessionId?: string }): Promise<ContextBriefPayload> {
    return this.lifecycle.run(async () => {
      const sessionId = await this.sessionApi.ensure(input.projectRoot, input.sessionId);
      if (!sessionId) throw new Error('Bridge session is required for getContextBrief');
      await this.deps.contextRecall.refreshSession(sessionId, input.projectRoot);
      return getContextBriefOp(this.deps, input.task, { projectId: input.projectRoot, sessionId });
    });
  }
  async recallLessons(input: { projectRoot?: string; task: string; sessionId?: string; limit?: number }): Promise<Memory[]> {
    return this.lifecycle.run(() => recallLessonsOp(
      this.deps,
      input.task,
      { projectId: input.projectRoot, sessionId: input.sessionId },
      input.limit ?? 5,
    ));
  }
  async pruneMemoriesDryRun(): Promise<PruneReport> {
    assertFullBridgeRuntime(this.config.databaseProvider, 'prune_memories_dry_run');
    return this.lifecycle.run(() => pruneMemoriesDryRunOp(this.deps));
  }
  async backfillMissingEmbeddings(input: { limit: number; projectId?: string; dryRun?: boolean }) {
    assertFullBridgeRuntime(this.config.databaseProvider, 'backfill_missing_embeddings');
    return this.lifecycle.run(() => backfillMissingEmbeddingsOp(this.deps, input.limit, input.projectId, input.dryRun));
  }
  async getCompactionReport(sessionId?: string): Promise<CompactionReportPayload> {
    assertFullBridgeRuntime(this.config.databaseProvider, 'get_compaction_report');
    return this.lifecycle.run(() => getCompactionReportOp(this.deps, sessionId));
  }
  async previewTeacherTraces(input: { projectRoot?: string; sessionId: string; limit?: number }): Promise<TeacherTraceSeedResult> { return this.lifecycle.run(async () => { assertFullBridgeRuntime(this.config.databaseProvider, 'preview_teacher_traces'); await this.sessionApi.ensure(input.projectRoot, input.sessionId); return previewTeacherTracesOp(this.deps, { projectId: input.projectRoot, sessionId: input.sessionId, limit: input.limit }); }); }
  async seedTeacherTraces(input: { projectRoot?: string; sessionId: string; limit?: number }): Promise<TeacherTraceSeedResult> { return this.lifecycle.run(async () => { assertFullBridgeRuntime(this.config.databaseProvider, 'seed_teacher_traces'); await this.sessionApi.ensure(input.projectRoot, input.sessionId); return seedTeacherTracesOp(this.deps, { projectId: input.projectRoot, sessionId: input.sessionId, limit: input.limit }); }); }
  async captureTraceVault(input: { projectRoot?: string; sessionId: string; sourceLabel?: string }): Promise<TraceVaultCaptureResult> { return this.lifecycle.run(async () => { assertFullBridgeRuntime(this.config.databaseProvider, 'capture_trace_vault'); await this.sessionApi.ensure(input.projectRoot, input.sessionId); return captureTraceVaultOp(this.deps, { sessionId: input.sessionId, projectId: input.projectRoot, sourceLabel: input.sourceLabel ?? 'work_journal' }); }); }
  async previewTraceVault(input: { projectRoot?: string; sessionId: string; limit?: number }): Promise<TraceVaultCaptureResult[]> { return this.lifecycle.run(async () => { assertFullBridgeRuntime(this.config.databaseProvider, 'preview_trace_vault'); await this.sessionApi.ensure(input.projectRoot, input.sessionId); return previewTraceVaultOp(this.deps, input.sessionId, input.limit); }); }
  async seedTeacherTracesFromVault(input: { projectRoot?: string; sessionId: string; limit?: number }): Promise<{ seeded: number; vault: TraceVaultCaptureResult[] }> { return this.lifecycle.run(async () => { assertFullBridgeRuntime(this.config.databaseProvider, 'seed_teacher_traces_from_vault'); await this.sessionApi.ensure(input.projectRoot, input.sessionId); return seedTeacherTracesFromVaultOp(this.deps, this.deps.memoryManager, input.sessionId, input.limit); }); }
  async resumeContext(input: { projectRoot: string; task: string; sessionId?: string; recentLimit?: number }): Promise<ResumeContextPayload> {
    return this.lifecycle.run(async () => {
      assertFullBridgeRuntime(this.config.databaseProvider, 'bridge_resume_context');
      const sessionId = await this.sessionApi.ensure(input.projectRoot, input.sessionId);
      if (!sessionId) throw new Error('Bridge session is required for resumeContext');
      return resumeContextOp(this.deps, { ...input, sessionId });
    });
  }
  async syncTurn(input: { projectRoot?: string; sessionId?: string; role: 'user' | 'assistant' | 'system'; content: string; tags?: string[]; metadata?: Record<string, unknown>; memoryType?: MemorySaveOptions['type'] }): Promise<SyncTurnPayload> {
    return this.lifecycle.run(async () => {
      assertFullBridgeRuntime(this.config.databaseProvider, 'bridge_sync_turn');
      const sessionId = await this.sessionApi.ensure(input.projectRoot, input.sessionId);
      if (!sessionId) throw new Error('Bridge session is required for syncTurn');
      return syncTurnOp(this.deps, {
        projectRoot: input.projectRoot ?? 'codex-bridge', sessionId, role: input.role,
        content: input.content, tags: input.tags, metadata: input.metadata,
        memoryType: input.memoryType,
      });
    });
  }
  async getHandoffSummary(input: { projectRoot: string; task?: string; sessionId?: string; recentLimit?: number }): Promise<HandoffSummaryPayload> {
    return this.lifecycle.run(async () => {
      assertFullBridgeRuntime(this.config.databaseProvider, 'bridge_handoff_summary');
      const sessionId = await this.sessionApi.ensure(input.projectRoot, input.sessionId);
      if (!sessionId) throw new Error('Bridge session is required for getHandoffSummary');
      return handoffSummaryOp(this.deps, {
        projectRoot: input.projectRoot, task: input.task ?? 'handoff summary',
        sessionId, recentLimit: input.recentLimit,
      });
    });
  }
  async beginWorkChange(input: WorkLedgerCaptureInput): Promise<void> {
    await this.ledgerApi.begin(input);
  }
  async completeWorkChange(input: WorkLedgerCaptureInput): Promise<WorkLedgerChange[]> {
    return this.ledgerApi.complete(input);
  }
  async getSurvivingWorkChanges(input: {
    runId: string;
    projectRoot?: string;
  }): Promise<WorkLedgerChange[]> {
    return this.ledgerApi.surviving(input.runId, input.projectRoot);
  }
  async correlateWorkChangesToCommit(input: {
    changeIds: string[];
    commitSha: string;
  }): Promise<number> {
    return this.ledgerApi.correlate(input.changeIds, input.commitSha);
  }
  async invokeExtra(name: string, input: Record<string, unknown>): Promise<unknown> { return this.lifecycle.run(async () => { assertBridgeExtraSupported(this.config.databaseProvider, name); const sessionless = new Set(['memory_project_list', 'memory_compact', 'csm_context_pressure', 'csm_runtime_status', 'csm_compaction_audit', 'csm_context_budget']); const projectRoot = input.projectRoot as string | undefined; if (!sessionless.has(name) && (!projectRoot || !projectRoot.trim())) throw new Error(`projectRoot must be a non-empty string for ${name}.`); const sessionId = sessionless.has(name) ? undefined : await this.sessionApi.ensure(projectRoot, input.sessionId as string | undefined); return invokeCodexBridgeExtra(this.deps, name as never, input, sessionId); }); }
  listTools(): string[] {
    return this.lifecycle.active
      ? bridgeToolNames(this.config.databaseProvider, this.config.workLedger.enabled) : [];
  }
  getDatabaseUrl(): string {
    return this.config.databaseUrl;
  }
}

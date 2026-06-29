import {
  getCompactionReportOp,
  getContextBriefOp,
  listMemoriesOp,
  saveMemoryOp,
  type BridgeDeps,
  type CompactionReportPayload,
  type ContextBriefPayload,
} from './bridge-ops.js';
import { buildBridgeActionPlan, type BridgeActionPlanItem } from './bridge-action-plan.js';
import { buildBridgeProvenanceMetadata, summarizeMemoryProvenance, type BridgeProvenanceSummary } from './bridge-provenance.js';
import { loadBridgeRecoveryState, type BridgeRecoveryStateSummary } from './bridge-recovery-state.js';
import { loadBridgeSessionState, type BridgeSessionStateSummary } from './bridge-session-state.js';
import { loadWorkJournalSummary, type BridgeWorkJournalSummary, writeBridgeTurnJournal } from './bridge-work-journal.js';
import { cacheBridgeWorkflowSignal } from './context-cache-signals.js';
import type { CheckpointStore } from './checkpoint-store.js';
import type { Memory, MemoryType } from './types.js';

export interface ResumeContextPayload extends ContextBriefPayload {
  sessionId: string;
  task: string;
  recent: Memory[];
  workJournal: BridgeWorkJournalSummary | null;
  provenance: BridgeProvenanceSummary;
  sessionState: BridgeSessionStateSummary | null;
  recovery: BridgeRecoveryStateSummary | null;
  actionPlan: BridgeActionPlanItem[];
}
export interface SyncTurnPayload {
  sessionId: string;
  channel: string;
  memory: Memory;
}
export interface HandoffSummaryPayload {
  sessionId: string;
  summary: string;
  context: ResumeContextPayload;
  compaction: CompactionReportPayload;
}

export async function resumeContextOp(
  deps: BridgeDeps,
  input: { projectRoot: string; task: string; sessionId: string; recentLimit?: number },
): Promise<ResumeContextPayload> {
  const context = await buildResumeContext(deps, input, false);
  if (deps.database) await cacheBridgeWorkflowSignal(deps.database.getPool(), { sessionId: input.sessionId, projectId: input.projectRoot, task: input.task, source: 'bridge_resume_context', summary: `Resume ${input.task}: ${previewText(context.actionPlan.map((item) => item.tool))}`, content: formatResumeCapture(context), actionPlan: context.actionPlan.map((item) => item.tool), activeGoal: context.sessionState?.activeGoal?.description, nextStep: context.workJournal?.nextStepInferred, checkpointId: context.recovery?.activeCheckpoint?.checkpointId, lastErrorId: context.recovery?.lastError?.displayId });
  return context;
}

export async function syncTurnOp(
  deps: BridgeDeps,
  input: {
    projectRoot: string;
    sessionId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
    memoryType?: MemoryType;
  },
): Promise<SyncTurnPayload> {
  const memory = await saveMemoryOp(deps, {
    content: `[${input.role}] ${input.content}`,
    type: input.memoryType ?? 'conversation',
    source: 'manual',
    tags: ['codex-bridge', input.role, ...(input.tags ?? [])],
    metadata: buildBridgeProvenanceMetadata(
      { role: input.role, syncedFrom: 'codex-mcp', ...(input.metadata ?? {}) },
      { sessionId: input.sessionId, projectRoot: input.projectRoot, sourceKind: 'transcript' },
    ),
    sessionId: input.sessionId,
  });
  const channel = 'codex_bridge.turn_synced';
  await deps.memoryManager.emitEvent(channel, {
    memoryId: memory.id,
    projectRoot: input.projectRoot,
    role: input.role,
  }, input.sessionId);
  if (deps.database) {
    await writeBridgeTurnJournal(deps.database.getPool(), {
      sessionId: input.sessionId,
      projectId: input.projectRoot,
      role: input.role,
      content: input.content,
      resultSummary: `Synced bridge turn into memory #${memory.id}.`,
    });
  }
  return { sessionId: input.sessionId, channel, memory };
}

export async function handoffSummaryOp(
  deps: BridgeDeps,
  input: { projectRoot: string; task: string; sessionId: string; recentLimit?: number },
): Promise<HandoffSummaryPayload> {
  const context = await buildResumeContext(deps, input, true);
  const compaction = await getCompactionReportOp(deps, input.sessionId);
  const summary = formatHandoffSummary(context, compaction);
  if (deps.database) await cacheBridgeWorkflowSignal(deps.database.getPool(), { sessionId: input.sessionId, projectId: input.projectRoot, task: input.task, source: 'bridge_handoff_summary', summary: `Handoff ${input.task}: ${previewText(context.actionPlan.map((item) => item.tool))}`, content: summary, actionPlan: context.actionPlan.map((item) => item.tool), activeGoal: context.sessionState?.activeGoal?.description, nextStep: context.workJournal?.nextStepInferred, checkpointId: context.recovery?.activeCheckpoint?.checkpointId, lastErrorId: context.recovery?.lastError?.displayId });
  return { sessionId: input.sessionId, summary, context, compaction };
}

function formatHandoffSummary(
  context: ResumeContextPayload,
  compaction: CompactionReportPayload,
): string {
  const lines = [
    `Project task: ${context.task}`,
    `Session: ${context.sessionId}`,
    '',
    'Context brief:',
    context.brief?.compressed ?? 'No cached context brief yet.',
    '',
    `Top lessons: ${preview(context.lessons)}`,
    `Active risks: ${preview(context.activeRisks)}`,
    `Recent memory: ${preview(context.recent)}`,
    context.sessionState?.activeGoal
      ? `Active goal: ${context.sessionState.activeGoal.description}`
      : 'Active goal: none.',
    context.sessionState?.latestFailure
      ? `Latest failure: ${context.sessionState.latestFailure.problem} -> ${context.sessionState.latestFailure.result}`
      : 'Latest failure: none.',
    context.recovery?.activeCheckpoint
      ? `Active checkpoint: ${context.recovery.activeCheckpoint.checkpointId.slice(0, 8)} at ${context.recovery.activeCheckpoint.createdAt}`
      : 'Active checkpoint: none.',
    context.recovery?.lastError
      ? `Cached error: ${context.recovery.lastError.summary}`
      : 'Cached error: none.',
    `Recent decisions: ${previewText(context.recovery?.recentDecisions.map((item) => item.summary))}`,
    `Checkpoint next steps: ${previewText(context.recovery?.activeCheckpoint?.nextSteps)}`,
    `Checkpoint refs: ${previewText(context.recovery?.activeCheckpoint?.expandableRefs.map((item) => item.refId))}`,
    `Recovery refs: ${previewRecoveryRefs(context.recovery)}`,
    `Suggested actions: ${previewText(context.actionPlan.map((item) => item.tool))}`,
    `Provenance: direct=${context.provenance.governanceEligibleCount}, context=${context.provenance.contextOnlyCount}, inferred=${context.provenance.inferredCount}, gap=${context.provenance.gapCount}`,
    `Recent steps: ${previewSteps(context.workJournal?.lastSteps)}`,
    `Recent errors: ${previewText(context.workJournal?.recentErrors)}`,
    `Files touched: ${previewText(context.workJournal?.filesTouched)}`,
    context.workJournal?.nextStepInferred
      ? `Next step: ${context.workJournal.nextStepInferred}`
      : 'Next step: none inferred from work journal.',
    compaction.available
      ? `Latest compaction saved ${String(compaction.metric?.tokens_saved ?? 0)} tokens.`
      : 'No compaction report available.',
  ];
  return lines.join('\n');
}

async function buildResumeContext(
  deps: BridgeDeps,
  input: { projectRoot: string; task: string; sessionId: string; recentLimit?: number },
  preferCurrentJournal: boolean,
): Promise<ResumeContextPayload> {
  await deps.contextRecall.refreshSession(input.sessionId, input.projectRoot);
  const context = await getContextBriefOp(deps, input.task, { projectId: input.projectRoot, sessionId: input.sessionId });
  const recent = await listMemoriesOp(
    deps,
    { projectId: input.projectRoot, sortBy: 'recent', limit: input.recentLimit ?? 5 },
    { projectId: input.projectRoot, sessionId: input.sessionId },
  );
  const workJournal = deps.database
    ? await loadWorkJournalSummary(deps.database.getPool(), {
        sessionId: input.sessionId,
        projectId: input.projectRoot,
        limit: input.recentLimit ?? 5,
        preferCurrent: preferCurrentJournal,
      })
    : null;
  const sessionState = deps.database
    ? await loadBridgeSessionState(deps.database.getPool(), input.sessionId)
    : null;
  const recovery = deps.database
    ? await loadBridgeRecoveryState(
        deps.database.getPool(),
        input.sessionId,
        input.task,
        getCheckpointStore(deps),
      )
    : null;
  const provenance = summarizeMemoryProvenance([...context.lessons, ...context.activeRisks, ...recent]);
  const actionPlan = buildBridgeActionPlan({ recovery, sessionState, workJournal });
  return { ...context, sessionId: input.sessionId, task: input.task, recent, workJournal, provenance, sessionState, recovery, actionPlan };
}

function preview(memories: Memory[]): string {
  if (memories.length === 0) return 'none';
  return memories
    .slice(0, 3)
    .map((memory) => memory.content.replace(/\s+/g, ' ').slice(0, 80))
    .join(' | ');
}

function formatResumeCapture(context: ResumeContextPayload): string {
  return [`Task: ${context.task}`, `Suggested actions: ${previewText(context.actionPlan.map((item) => item.tool))}`, `Active goal: ${context.sessionState?.activeGoal?.description ?? 'none'}`, `Latest failure: ${context.sessionState?.latestFailure?.problem ?? 'none'}`, `Next step: ${context.workJournal?.nextStepInferred ?? 'none'}`].join('\n');
}
function previewSteps(steps?: string[]): string { return previewText(steps); }
function previewText(values?: string[]): string { return !values || values.length === 0 ? 'none' : values.slice(0, 3).join(' | '); }

function previewRecoveryRefs(context: ResumeContextPayload['recovery']): string {
  if (!context) return 'none';
  const refs = [
    ...context.activeCheckpoint?.expandableRefs.map((item) => item.refId) ?? [],
    context.lastError?.displayId,
    ...context.recentDecisions.map((item) => item.displayId),
    context.activeCheckpoint ? 'list_checkpoints(limit=3)' : undefined,
  ];
  return previewText(refs.filter((value): value is string => Boolean(value)));
}

function getCheckpointStore(deps: BridgeDeps): Pick<CheckpointStore, 'getActiveCheckpoint'> | undefined { return (deps as BridgeDeps & { checkpointStore?: Pick<CheckpointStore, 'getActiveCheckpoint'> }).checkpointStore; }

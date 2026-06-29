import { fetchDecisions, fetchLastError, fetchLatestDecisionBySource, searchLatestDecisionBySources, type CacheItem } from './context-cache-store.js';
import type { CheckpointStore } from './checkpoint-store.js';
import type { DatabasePool } from './types.js';

export interface BridgeRecoveryAction {
  tool: 'context_fetch' | 'list_checkpoints' | 'expand_checkpoint_ref';
  args: Record<string, unknown>;
}

export interface BridgeCheckpointRefSummary {
  refId: string;
  label: string;
  note: string;
  expandAction: BridgeRecoveryAction;
}

export interface BridgeRecoveryItemSummary {
  displayId: string;
  summary: string;
  createdAt: number;
  fetchAction: BridgeRecoveryAction;
}

export interface BridgeCheckpointSummary {
  checkpointId: string;
  createdAt: string;
  summaryExcerpt: string;
  filesMentioned: string[];
  nextSteps: string[];
  risks: string[];
  expandableRefs: BridgeCheckpointRefSummary[];
  reviewAction: BridgeRecoveryAction;
}

export interface BridgeRecoveryStateSummary {
  activeCheckpoint: BridgeCheckpointSummary | null;
  lastError: BridgeRecoveryItemSummary | null;
  lastHandoff: BridgeRecoveryItemSummary | null;
  lastResume: BridgeRecoveryItemSummary | null;
  matchingWorkflow: BridgeRecoveryItemSummary | null;
  recentDecisions: BridgeRecoveryItemSummary[];
}

type BridgeCheckpointLookup = Pick<CheckpointStore, 'getActiveCheckpoint'>;

export async function loadBridgeRecoveryState(
  pool: DatabasePool,
  sessionId: string,
  task: string,
  checkpointStore?: BridgeCheckpointLookup,
): Promise<BridgeRecoveryStateSummary> {
  const [checkpoint, lastError, lastHandoff, lastResume, matchingWorkflow, recentDecisions] = await Promise.all([
    checkpointStore?.getActiveCheckpoint(sessionId) ?? Promise.resolve(null),
    fetchLastError(pool, sessionId),
    fetchLatestDecisionBySource(pool, sessionId, 'bridge_handoff_summary'),
    fetchLatestDecisionBySource(pool, sessionId, 'bridge_resume_context'),
    searchLatestDecisionBySources(pool, sessionId, task, ['bridge_handoff_summary', 'bridge_resume_context']),
    fetchDecisions(pool, sessionId, 3),
  ]);

  return {
    activeCheckpoint: checkpoint
      ? {
          checkpointId: checkpoint.checkpointId,
          createdAt: checkpoint.createdAt.toISOString(),
          summaryExcerpt: checkpoint.summaryMarkdown.replace(/\s+/g, ' ').slice(0, 160),
          filesMentioned: checkpoint.filesMentioned,
          nextSteps: checkpoint.nextSteps,
          risks: checkpoint.risks,
          expandableRefs: checkpoint.sourceRefs.map(toCheckpointRefSummary).filter(isCheckpointRefSummary).slice(0, 3),
          reviewAction: { tool: 'list_checkpoints', args: { limit: 3 } },
        }
      : null,
    lastError: toItemSummary(lastError),
    lastHandoff: toItemSummary(lastHandoff),
    lastResume: toItemSummary(lastResume),
    matchingWorkflow: toItemSummary(matchingWorkflow),
    recentDecisions: recentDecisions
      .filter((item) => item.displayId !== lastHandoff?.displayId && item.displayId !== lastResume?.displayId && item.displayId !== matchingWorkflow?.displayId)
      .map(toDecisionSummary),
  };
}

function toItemSummary(item: CacheItem | null): BridgeRecoveryItemSummary | null {
  if (!item) return null;
  return toDecisionSummary(item);
}

function toDecisionSummary(item: CacheItem): BridgeRecoveryItemSummary {
  return {
    displayId: item.displayId,
    summary: item.summary,
    createdAt: item.createdAt,
    fetchAction: { tool: 'context_fetch', args: { id: item.displayId } },
  };
}

function toCheckpointRefSummary(ref: { messageId?: string; toolCallId?: string; role: string; kind: string; note: string }): BridgeCheckpointRefSummary | null {
  const refId = ref.toolCallId ?? ref.messageId;
  if (!refId) return null;
  return {
    refId,
    label: `${ref.role}:${ref.kind}`,
    note: ref.note,
    expandAction: { tool: 'expand_checkpoint_ref', args: { refId } },
  };
}

function isCheckpointRefSummary(value: BridgeCheckpointRefSummary | null): value is BridgeCheckpointRefSummary {
  return Boolean(value);
}

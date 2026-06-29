import type { BridgeRecoveryAction, BridgeRecoveryStateSummary } from './bridge-recovery-state.js';
import type { BridgeSessionStateSummary } from './bridge-session-state.js';
import type { BridgeWorkJournalSummary } from './bridge-work-journal.js';

export interface BridgeActionPlanItem {
  title: string;
  tool: BridgeRecoveryAction['tool'];
  args: Record<string, unknown>;
  reason: string;
  priority: number;
}

export function buildBridgeActionPlan(input: {
  recovery: BridgeRecoveryStateSummary | null;
  sessionState: BridgeSessionStateSummary | null;
  workJournal: BridgeWorkJournalSummary | null;
}): BridgeActionPlanItem[] {
  const actions: BridgeActionPlanItem[] = [];
  const checkpointRef = input.recovery?.activeCheckpoint?.expandableRefs[0];
  if (checkpointRef) actions.push({ title: 'Expand checkpoint ref', tool: checkpointRef.expandAction.tool, args: checkpointRef.expandAction.args, reason: checkpointRef.note, priority: 1 });
  const matchingWorkflow = input.recovery?.matchingWorkflow;
  if (matchingWorkflow) actions.push({ title: 'Fetch matching workflow', tool: matchingWorkflow.fetchAction.tool, args: matchingWorkflow.fetchAction.args, reason: matchingWorkflow.summary, priority: 1 });
  const lastError = input.recovery?.lastError;
  if (lastError) actions.push({ title: 'Fetch cached error', tool: lastError.fetchAction.tool, args: lastError.fetchAction.args, reason: lastError.summary, priority: 1 });
  const lastHandoff = input.recovery?.lastHandoff;
  if (lastHandoff) actions.push({ title: 'Fetch latest handoff', tool: lastHandoff.fetchAction.tool, args: lastHandoff.fetchAction.args, reason: lastHandoff.summary, priority: 2 });
  const lastResume = input.recovery?.lastResume;
  if (lastResume) actions.push({ title: 'Fetch latest resume', tool: lastResume.fetchAction.tool, args: lastResume.fetchAction.args, reason: lastResume.summary, priority: 2 });
  const decision = input.recovery?.recentDecisions[0];
  if (decision) actions.push({ title: 'Fetch latest decision', tool: decision.fetchAction.tool, args: decision.fetchAction.args, reason: decision.summary, priority: 2 });
  const checkpoint = input.recovery?.activeCheckpoint;
  if (checkpoint) actions.push({ title: 'Review active checkpoint', tool: checkpoint.reviewAction.tool, args: checkpoint.reviewAction.args, reason: checkpoint.summaryExcerpt, priority: 2 });
  if (input.workJournal?.nextStepInferred && input.sessionState?.activeGoal) {
    actions.push({ title: 'Resume goal path', tool: 'context_fetch', args: { id: input.recovery?.lastError?.displayId ?? input.recovery?.recentDecisions[0]?.displayId ?? '' }, reason: input.workJournal.nextStepInferred, priority: 3 });
  }
  return actions
    .filter((action) => Object.values(action.args).some(Boolean))
    .sort((left, right) => left.priority - right.priority)
    .slice(0, 5);
}

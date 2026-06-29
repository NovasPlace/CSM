import type { CheckpointStore } from './checkpoint-store.js';
import type { DistillerConfig } from './types.js';
import type { CheckpointConfig } from './checkpoint-types.js';
import type { ContextCompactor } from './context-compactor.js';
import type { ContextRecallDaemon } from './context-recall.js';
import type { Database } from './database.js';
import type { MemoryExtractor } from './memory-extractor.js';
import type { MemoryManager } from './memory-manager.js';
import type { PrimingEngine } from './priming-engine.js';
import { contextBudgetOp } from './codex-bridge-extra-budget-ops.js';
import { contextFetchDecisionLogOp, contextFetchFileRegionOp, contextFetchLastErrorOp, contextFetchOp, contextPressureOp, contextReviewOp, createCheckpointOp, expandCheckpointRefOp, goalListOp, goalSetOp, goalUpdateOp, listCheckpointsOp, runtimeStatusOp, compactionAuditOp as csmCompactionAuditOp } from './codex-bridge-extra-state-ops.js';
import { memoryBackfillOp, memoryCleanupOp, memoryCompactOp, memoryContextOp, memoryDeleteOp, memoryDistillOp, memoryDistilledViewOp, memoryLessonOp, memoryProjectListOp, memoryTranscriptOp } from './codex-bridge-extra-memory-ops.js';
import { reviewCandidateOp } from './codex-bridge-extra-memory-ops.js';
import { searchItems } from './context-cache-store.js';

export interface CodexBridgeExtraDeps {
  database: Database;
  memoryManager: MemoryManager;
  memoryExtractor: MemoryExtractor;
  checkpointStore: CheckpointStore;
  checkpointConfig: CheckpointConfig;
  distillerConfig: DistillerConfig;
  contextCompactor: ContextCompactor;
  contextRecall: ContextRecallDaemon;
  primingEngine: PrimingEngine;
}

export type CodexBridgeExtraName =
  | 'memory_transcript' | 'memory_delete' | 'memory_context' | 'memory_lesson'
  | 'memory_candidate_list' | 'memory_candidate_approve' | 'memory_candidate_reject'
  | 'memory_project_list' | 'memory_cleanup' | 'memory_distill' | 'memory_distilled_view'
  | 'memory_compact' | 'memory_backfill_embeddings' | 'context_review' | 'context_fetch'
  | 'context_search' | 'context_fetch_file_region' | 'context_fetch_last_error'
  | 'context_fetch_decision_log' | 'goal_set' | 'goal_update' | 'goal_list'
  | 'create_checkpoint' | 'list_checkpoints' | 'expand_checkpoint_ref' | 'csm_context_pressure'
  | 'csm_context_budget' | 'csm_runtime_status' | 'csm_compaction_audit';

export const EXTRA_BRIDGE_TOOL_NAMES: CodexBridgeExtraName[] = [
  'memory_transcript','memory_delete','memory_context','memory_lesson','memory_candidate_list',
  'memory_candidate_approve','memory_candidate_reject','memory_project_list','memory_cleanup',
  'memory_distill','memory_distilled_view','memory_compact','memory_backfill_embeddings',
  'context_review','context_fetch','context_search','context_fetch_file_region','context_fetch_last_error',
  'context_fetch_decision_log','goal_set','goal_update','goal_list','create_checkpoint','list_checkpoints',
  'csm_context_pressure','csm_context_budget',
  'expand_checkpoint_ref','csm_runtime_status','csm_compaction_audit',
];

export async function invokeCodexBridgeExtra(
  deps: CodexBridgeExtraDeps,
  name: CodexBridgeExtraName,
  input: Record<string, unknown>,
  sessionId?: string,
): Promise<unknown> {
  if (name === 'memory_transcript') return memoryTranscriptOp(deps.memoryManager, sessionId, input);
  if (name === 'memory_delete') return memoryDeleteOp(deps.memoryManager, input.id);
  if (name === 'memory_context') return memoryContextOp(deps, sessionId, input);
  if (name === 'memory_lesson') return memoryLessonOp(deps.memoryManager, sessionId, input);
  if (name === 'memory_candidate_list') return { candidates: await deps.memoryExtractor.getPendingCandidates(sessionId, limit(input.limit, 50)) };
  if (name === 'memory_candidate_approve' || name === 'memory_candidate_reject') return reviewCandidateOp(deps.memoryExtractor, name, input, sessionId);
  if (name === 'memory_project_list') return memoryProjectListOp(deps.memoryManager);
  if (name === 'memory_cleanup') return memoryCleanupOp(deps.memoryManager);
  if (name === 'memory_distill') return memoryDistillOp(deps, sessionId, input);
  if (name === 'memory_distilled_view') return memoryDistilledViewOp(deps.database, sessionId, input);
  if (name === 'memory_compact') return memoryCompactOp(deps);
  if (name === 'memory_backfill_embeddings') return memoryBackfillOp(deps.memoryManager, input);
  if (name === 'context_review') return contextReviewOp(deps, sessionId, input);
  if (name === 'context_fetch') return contextFetchOp(deps, sessionId, input);
  if (name === 'context_search') return { items: await searchItems(deps.database.getPool(), requireSession(sessionId), requireString(input.query, 'query'), limit(input.limit, 10)) };
  if (name === 'context_fetch_file_region') return contextFetchFileRegionOp(deps, sessionId, input);
  if (name === 'context_fetch_last_error') return contextFetchLastErrorOp(deps, sessionId);
  if (name === 'context_fetch_decision_log') return contextFetchDecisionLogOp(deps, sessionId, input);
  if (name === 'goal_set') return goalSetOp(deps, sessionId, input);
  if (name === 'goal_update') return goalUpdateOp(deps, sessionId, input);
  if (name === 'goal_list') return goalListOp(deps, sessionId, input);
  if (name === 'csm_context_pressure') return contextPressureOp(deps, input);
  if (name === 'csm_context_budget') return contextBudgetOp(input);
  if (name === 'create_checkpoint') return createCheckpointOp(deps, sessionId, input);
  if (name === 'list_checkpoints') return listCheckpointsOp(deps, sessionId, input);
  if (name === 'expand_checkpoint_ref') return expandCheckpointRefOp(deps, sessionId, input);
  if (name === 'csm_runtime_status') return runtimeStatusOp(deps, sessionId);
  if (name === 'csm_compaction_audit') return csmCompactionAuditOp(deps);
  throw new Error(`Unknown extra tool: ${name}`);
}

function requireSession(sessionId: string | undefined): string {
  if (!sessionId) throw new Error('sessionId is required for this tool.');
  return sessionId;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be a non-empty string.`);
  return value.trim();
}

function limit(value: unknown, fallback: number): number {
  return typeof value === 'number' ? Math.max(1, Math.min(value, 100)) : fallback;
}

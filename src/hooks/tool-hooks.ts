import {
  memorySaveTool, memorySearchTool, memoryListTool, memoryDeleteTool,
  memoryContextTool, memoryLessonTool, memoryTranscriptTool,
  memoryDistillTool, memoryDistilledViewTool, memoryCompactTool,
  runtimeStatusTool, compactionAuditTool,
} from '../tools.js';
import { memoryBackfillEmbeddingsTool, memoryDedupDetectTool } from '../maintenance-tools.js';
import { goalSetTool, goalUpdateTool, goalListTool } from '../goal-tools.js';
import { createCheckpointTool, expandCheckpointRefTool, listCheckpointsTool } from '../checkpoint-tool.js';
import { contextReviewTool } from '../context-review-tool.js';
import {
  contextFetchTool, contextSearchTool, contextFetchFileRegionTool,
  contextFetchLastErrorTool, contextFetchDecisionLogTool,
} from '../context-cache-tools.js';
import type { PluginContext } from '../plugin-context.js';
import { EmbeddingBackfill } from '../embedding-backfill.js';
import { DedupCandidateDetector } from '../dedup-detector.js';

export function registerTools(pluginCtx: PluginContext): Record<string, any> {
  const {
    memoryManager, database, primingEngine, contextRecall,
    toolDistiller, memoryExtractor, redactor, contextCompactor,
    checkpointStore, checkpointToolDeps, config, embeddings,
  } = pluginCtx;

  const backfill = new EmbeddingBackfill(database, embeddings);
  const dedupDetector = new DedupCandidateDetector(database);

  return {
    csm_memory_save: memorySaveTool(memoryManager),
    csm_memory_search: memorySearchTool(memoryManager, primingEngine),
    csm_memory_list: memoryListTool(memoryManager),
    csm_memory_delete: memoryDeleteTool(memoryManager),
    csm_memory_context: memoryContextTool(contextRecall),
    csm_memory_lesson: memoryLessonTool(memoryManager),
    csm_memory_transcript: memoryTranscriptTool(memoryManager),
    csm_memory_distill: memoryDistillTool(toolDistiller, database, memoryExtractor, redactor),
    csm_memory_distilled_view: memoryDistilledViewTool(database),
    csm_memory_compact: memoryCompactTool(contextCompactor),
    csm_memory_backfill_embeddings: memoryBackfillEmbeddingsTool(backfill),
    csm_memory_dedup_detect: memoryDedupDetectTool(dedupDetector),
    csm_runtime_status: runtimeStatusTool(database, memoryManager, config, pluginCtx.state.currentSessionId),
    csm_compaction_audit: compactionAuditTool(database),
    create_checkpoint: createCheckpointTool(checkpointToolDeps),
    expand_checkpoint_ref: expandCheckpointRefTool(checkpointToolDeps),
    list_checkpoints: listCheckpointsTool(checkpointToolDeps),
    context_review: contextReviewTool({ pool: database.getPool() }),
    context_fetch: contextFetchTool({ pool: database.getPool() }),
    context_search: contextSearchTool({ pool: database.getPool() }),
    context_fetch_file_region: contextFetchFileRegionTool({ pool: database.getPool() }),
    context_fetch_last_error: contextFetchLastErrorTool({ pool: database.getPool() }),
    context_fetch_decision_log: contextFetchDecisionLogTool({ pool: database.getPool() }),
    goal_set: goalSetTool({ pool: database.getPool() }),
    goal_update: goalUpdateTool({ pool: database.getPool() }),
    goal_list: goalListTool({ pool: database.getPool() }),
  };
}

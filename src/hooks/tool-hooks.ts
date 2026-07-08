import {
  memorySaveTool, memorySearchTool, memoryListTool, memoryDeleteTool,
  memoryContextTool, memoryLessonTool, memoryTranscriptTool,
  memoryDistillTool, memoryDistilledViewTool, memoryCompactTool,
  runtimeStatusTool, compactionAuditTool, recallQualityReportTool, memoryRelatedTool, continuityReportTool,
} from '../tools.js';
import { memoryBackfillEmbeddingsTool, memoryDedupDetectTool, memoryMergeDuplicatesTool, memoryCandidateGenerateTool, memoryCandidateReportTool } from '../maintenance-tools.js';
import { archiveCandidateReportTool } from '../archive-candidate-report-tool.js';
import { memoryGovernanceReportTool } from '../memory-governance-report-tool.js';
import { memoryPacketsTool } from '../experience-packet-tool.js';
import { beliefScanTool, beliefScanReportTool } from '../belief-scan-tool.js';
import { BeliefPromotionScanner } from '../belief-promotion-scanner.js';
import { BeliefPromotionEngine } from '../belief-promotion.js';
import { beliefPromotionTool, beliefPromotionScanTool } from '../belief-promotion-tool.js';
import { selfModelTool } from '../self-model-tool.js';
import { beliefKnowledgeTool } from '../belief-knowledge-tool.js';
import { livingStatePreviewTool, livingStateDebugTool } from '../living-state-tool.js';
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
import { MemoryMerger } from '../merge-tool.js';
import { CandidateGenerator } from '../candidate-generator.js';
import { ArchiveCandidateReportBuilder } from '../archive-candidate-report.js';
import { MemoryGovernanceReportBuilder } from '../memory-governance-report.js';

export function registerTools(pluginCtx: PluginContext): Record<string, unknown> {
  const {
    memoryManager, database, primingEngine, contextRecall,
    toolDistiller, memoryExtractor, redactor, contextCompactor,
    checkpointStore: _checkpointStore, checkpointToolDeps, config, embeddings,
  } = pluginCtx;
  const experiencePackets = pluginCtx.experiencePackets;

  const beliefScanner = new BeliefPromotionScanner(database.getPool());
  const beliefPromotion = new BeliefPromotionEngine(database.getPool(), memoryManager, config.beliefPromotion);

  const backfill = new EmbeddingBackfill(database, embeddings);
  const dedupDetector = new DedupCandidateDetector(database);
  const memoryMerger = new MemoryMerger(database);
  const candidateGenerator = new CandidateGenerator(database);
  const archiveCandidateReportBuilder = new ArchiveCandidateReportBuilder(database);
  const governanceReportBuilder = new MemoryGovernanceReportBuilder(database);

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
    csm_memory_merge: memoryMergeDuplicatesTool(memoryMerger),
    csm_memory_candidate_generate: memoryCandidateGenerateTool(candidateGenerator),
    csm_memory_candidate_report: memoryCandidateReportTool(candidateGenerator),
    csm_memory_archive_candidate_report: archiveCandidateReportTool(archiveCandidateReportBuilder),
    csm_memory_governance_report: memoryGovernanceReportTool(governanceReportBuilder),
    csm_memory_packets: memoryPacketsTool(experiencePackets),
    csm_belief_scan: beliefScanTool(beliefScanner),
    csm_belief_scan_report: beliefScanReportTool(beliefScanner),
    csm_belief_promote: beliefPromotionTool(beliefPromotion, config.beliefPromotion),
    csm_belief_promotion_scan: beliefPromotionScanTool(beliefPromotion, config.beliefPromotion),
    csm_self_model: selfModelTool(pluginCtx.selfModel),
    csm_belief_knowledge: beliefKnowledgeTool(pluginCtx.beliefKnowledge),
    csm_living_state_preview: livingStatePreviewTool(pluginCtx.livingState),
    csm_living_state_debug: livingStateDebugTool(pluginCtx.livingStateAdvisor),
    csm_runtime_status: runtimeStatusTool(database, memoryManager, config, pluginCtx.state.currentSessionId),
    csm_compaction_audit: compactionAuditTool(database),
    csm_recall_quality_report: recallQualityReportTool(database),
    csm_memory_related: memoryRelatedTool(database),
    csm_continuity_report: continuityReportTool(database),
    create_checkpoint: createCheckpointTool(checkpointToolDeps),
    expand_checkpoint_ref: expandCheckpointRefTool(checkpointToolDeps),
    list_checkpoints: listCheckpointsTool(checkpointToolDeps),
    context_review: contextReviewTool({ pool: database.getPool() }),
    context_fetch: contextFetchTool({ pool: database.getPool() }),
    context_search: contextSearchTool({ pool: database.getPool() }),
    context_fetch_file_region: contextFetchFileRegionTool({ pool: database.getPool() }),
    context_fetch_last_error: contextFetchLastErrorTool({ pool: database.getPool() }),
    context_fetch_decision_log: contextFetchDecisionLogTool({ pool: database.getPool() }),
    context_fault: pluginCtx.vcmManager.faultTool(),
    goal_set: goalSetTool({ pool: database.getPool() }),
    goal_update: goalUpdateTool({ pool: database.getPool() }),
    goal_list: goalListTool({ pool: database.getPool() }),
  };
}

import { createAgentBookTools } from '../agentbook-tool.js';
import { archiveCandidateReportTool } from '../archive-candidate-report-tool.js';
import { ArchiveCandidateReportBuilder } from '../archive-candidate-report.js';
import { beliefKnowledgeTool } from '../belief-knowledge-tool.js';
import { beliefPromotionScanTool, beliefPromotionTool } from '../belief-promotion-tool.js';
import { BeliefPromotionScanner } from '../belief-promotion-scanner.js';
import { BeliefPromotionEngine } from '../belief-promotion.js';
import { beliefScanReportTool, beliefScanTool } from '../belief-scan-tool.js';
import { CandidateGenerator } from '../candidate-generator.js';
import { createCheckpointTool, expandCheckpointRefTool, listCheckpointsTool } from '../checkpoint-tool.js';
import { contextReviewTool } from '../context-review-tool.js';
import {
  contextFetchDecisionLogTool, contextFetchFileRegionTool, contextFetchLastErrorTool,
  contextFetchTool, contextSearchTool,
} from '../context-cache-tools.js';
import { DedupCandidateDetector } from '../dedup-detector.js';
import { EmbeddingBackfill } from '../embedding-backfill.js';
import { memoryPacketsTool } from '../experience-packet-tool.js';
import { goalListTool, goalSetTool, goalUpdateTool } from '../goal-tools.js';
import { livingStateDebugTool, livingStatePreviewTool } from '../living-state-tool.js';
import {
  memoryBackfillEmbeddingsTool, memoryCandidateGenerateTool, memoryCandidateReportTool,
  memoryDedupDetectTool, memoryMergeDuplicatesTool,
} from '../maintenance-tools.js';
import { MemoryGovernanceReportBuilder } from '../memory-governance-report.js';
import { memoryGovernanceReportTool } from '../memory-governance-report-tool.js';
import { MemoryMerger } from '../merge-tool.js';
import { onboardAgentTool } from '../agent-onboarding-tool.js';
import type { PluginContext } from '../plugin-context.js';
import { ReEntryPreviewAdapter } from '../reentry-ux-tool.js';
import { selfModelTool } from '../self-model-tool.js';
import {
  compactionAuditTool, continuityReportTool, memoryCompactTool, memoryContextTool,
  memoryDeleteTool, memoryDistillTool, memoryDistilledViewTool, memoryLessonTool,
  memoryListTool, memoryRelatedTool, memorySaveTool, memorySearchTool,
  memoryTranscriptTool, recallQualityReportTool, reentryPreviewTool, runtimeStatusTool,
} from '../tools.js';
import { wikiExportTool } from '../wiki-export-tool.js';
import { workLedgerSurvivingTool } from '../work-ledger-tool.js';

interface MaintenanceServices {
  backfill: EmbeddingBackfill;
  dedup: DedupCandidateDetector;
  merger: MemoryMerger;
  candidates: CandidateGenerator;
  archive: ArchiveCandidateReportBuilder;
  governance: MemoryGovernanceReportBuilder;
  beliefScanner: BeliefPromotionScanner;
  beliefPromotion: BeliefPromotionEngine;
}

export function createRegisteredToolList(ctx: PluginContext): Record<string, unknown> {
  const services = maintenanceServices(ctx);
  const tools = {
    ...memoryTools(ctx),
    ...maintenanceTools(ctx, services),
    ...livingStateTools(ctx),
    ...operationalTools(ctx),
  };
  appendOptionalTools(ctx, tools);
  return tools;
}

function memoryTools(ctx: PluginContext): Record<string, unknown> {
  const { memoryManager, primingEngine, contextRecall, toolDistiller, database,
    memoryExtractor, redactor, contextCompactor } = ctx;
  return {
    csm_memory_save: memorySaveTool(memoryManager, ctx.directory),
    csm_memory_search: memorySearchTool(memoryManager, primingEngine, ctx.directory),
    csm_memory_list: memoryListTool(memoryManager, ctx.directory),
    csm_memory_delete: memoryDeleteTool(memoryManager, ctx.directory),
    csm_memory_context: memoryContextTool(contextRecall),
    csm_memory_lesson: memoryLessonTool(memoryManager, ctx.directory),
    csm_memory_transcript: memoryTranscriptTool(memoryManager, ctx.directory),
    csm_memory_distill: memoryDistillTool(toolDistiller, database, memoryExtractor, ctx.directory, redactor),
    csm_memory_distilled_view: memoryDistilledViewTool(database),
    csm_memory_compact: memoryCompactTool(contextCompactor),
    csm_memory_packets: memoryPacketsTool(ctx.experiencePackets),
  };
}

function maintenanceTools(ctx: PluginContext, services: MaintenanceServices): Record<string, unknown> {
  return {
    csm_memory_backfill_embeddings: memoryBackfillEmbeddingsTool(services.backfill, ctx.directory),
    csm_memory_dedup_detect: memoryDedupDetectTool(services.dedup, ctx.directory),
    csm_memory_merge: memoryMergeDuplicatesTool(services.merger, ctx.directory),
    csm_memory_candidate_generate: memoryCandidateGenerateTool(services.candidates, ctx.directory),
    csm_memory_candidate_report: memoryCandidateReportTool(services.candidates, ctx.directory),
    csm_memory_archive_candidate_report: archiveCandidateReportTool(services.archive, ctx.directory),
    csm_memory_governance_report: memoryGovernanceReportTool(services.governance, ctx.directory),
    csm_belief_scan: beliefScanTool(services.beliefScanner, ctx.directory),
    csm_belief_scan_report: beliefScanReportTool(services.beliefScanner),
    csm_belief_promote: beliefPromotionTool(services.beliefPromotion, ctx.config.beliefPromotion),
    csm_belief_promotion_scan: beliefPromotionScanTool(services.beliefPromotion, ctx.config.beliefPromotion),
  };
}

function livingStateTools(ctx: PluginContext): Record<string, unknown> {
  const { database, memoryManager, config } = ctx;
  return {
    csm_self_model: selfModelTool(ctx.selfModel),
    csm_belief_knowledge: beliefKnowledgeTool(ctx.beliefKnowledge),
    csm_living_state_preview: livingStatePreviewTool(ctx.livingState),
    csm_living_state_debug: livingStateDebugTool(ctx.livingStateAdvisor),
    ...createAgentBookTools({ eventStore: ctx.agentBookEvents, rulesStore: ctx.agentBookRules,
      stateProjector: ctx.agentBookState, summaryGenerator: ctx.agentBookSummary }, ctx.directory, ctx.worktree ?? ctx.directory),
    csm_runtime_status: runtimeStatusTool(database, memoryManager, config, ctx.state.currentSessionId),
    csm_compaction_audit: compactionAuditTool(database),
    csm_recall_quality_report: recallQualityReportTool(database, ctx.directory),
    csm_memory_related: memoryRelatedTool(database, ctx.directory),
    csm_continuity_report: continuityReportTool(database, {
      protocol: ctx.reEntryProtocol, config: config.reentry,
      reentryInjected: ctx.state.reentryInjected, projectId: ctx.directory,
    }),
  };
}

function operationalTools(ctx: PluginContext): Record<string, unknown> {
  const pool = ctx.database.getPool();
  const checkpoint = ctx.checkpointToolDeps;
  return {
    create_checkpoint: createCheckpointTool(checkpoint),
    expand_checkpoint_ref: expandCheckpointRefTool(checkpoint),
    list_checkpoints: listCheckpointsTool(checkpoint),
    context_review: contextReviewTool({ pool }),
    context_fetch: contextFetchTool({ pool }),
    context_search: contextSearchTool({ pool }),
    context_fetch_file_region: contextFetchFileRegionTool({ pool }),
    context_fetch_last_error: contextFetchLastErrorTool({ pool }),
    context_fetch_decision_log: contextFetchDecisionLogTool({ pool }),
    context_fault: ctx.vcmManager.faultTool(),
    goal_set: goalSetTool({ pool }), goal_update: goalUpdateTool({ pool }), goal_list: goalListTool({ pool }),
    csm_onboard_agent: onboardAgentTool(ctx),
    csm_wiki_export: wikiExportTool(ctx.database, ctx.directory),
  };
}

function maintenanceServices(ctx: PluginContext): MaintenanceServices {
  const pool = ctx.database.getPool();
  return {
    backfill: new EmbeddingBackfill(ctx.database, ctx.embeddings),
    dedup: new DedupCandidateDetector(ctx.database), merger: new MemoryMerger(ctx.database),
    candidates: new CandidateGenerator(ctx.database), archive: new ArchiveCandidateReportBuilder(ctx.database),
    governance: new MemoryGovernanceReportBuilder(ctx.database),
    beliefScanner: new BeliefPromotionScanner(pool),
    beliefPromotion: new BeliefPromotionEngine(pool, ctx.memoryManager, ctx.config.beliefPromotion),
  };
}

function appendOptionalTools(ctx: PluginContext, tools: Record<string, unknown>): void {
  if (ctx.workLedger) {
    tools.csm_work_ledger_surviving = workLedgerSurvivingTool(ctx.workLedger, ctx.state, ctx.directory);
  }
  if (ctx.reEntryProtocol) {
    const adapter = new ReEntryPreviewAdapter(ctx.reEntryProtocol, ctx.config.reentry);
    tools.csm_reentry_preview = reentryPreviewTool(adapter, ctx.directory);
  }
}

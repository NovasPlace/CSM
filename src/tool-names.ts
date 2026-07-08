/**
 * Central list of all CSM tool names.
 * Extracted to break circular dependency: tools.ts → tool-hooks.ts → tools.ts
 */
export const CSM_TOOL_NAMES = [
   'csm_memory_save',
   'csm_memory_search',
   'csm_memory_list',
   'csm_memory_delete',
   'csm_memory_context',
   'csm_memory_lesson',
   'csm_memory_transcript',
   'csm_memory_distill',
   'csm_memory_distilled_view',
   'csm_memory_compact',
   'csm_memory_backfill_embeddings',
   'csm_memory_dedup_detect',
   'csm_memory_merge',
   'csm_memory_candidate_generate',
   'csm_memory_candidate_report',
   'csm_memory_archive_candidate_report',
   'csm_memory_governance_report',
   'csm_runtime_status',
   'csm_compaction_audit',
   'csm_memory_packets',
   'csm_belief_scan',
   'csm_belief_scan_report',
   'csm_belief_promote',
   'csm_belief_promotion_scan',
   'csm_self_model',
   'csm_belief_knowledge',
   'csm_living_state_preview',
   'csm_living_state_debug',
   'csm_recall_quality_report',
   'csm_memory_related',
   'csm_continuity_report',
   'csm_reentry_preview',
 ] as const;

export type CsmToolName = typeof CSM_TOOL_NAMES[number];

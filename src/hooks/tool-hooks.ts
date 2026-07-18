import type { PluginContext } from '../plugin-context.js';
import { isReentrySourceOnlyActive, REENTRY_SOURCE_ONLY_RECOVERY_MESSAGE } from './reentry-source-only.js';
import { createRegisteredToolList } from './tool-registry.js';

const SQLITE_UNSUPPORTED_TOOLS = [
  'csm_memory_backfill_embeddings', 'csm_memory_distill', 'csm_memory_distilled_view',
  'csm_memory_dedup_detect', 'csm_memory_merge', 'csm_memory_candidate_generate', 'csm_memory_candidate_report',
  'csm_memory_archive_candidate_report', 'csm_memory_governance_report',
  'csm_belief_scan', 'csm_belief_scan_report', 'csm_belief_promote',
  'csm_belief_promotion_scan', 'csm_self_model', 'csm_belief_knowledge',
  'csm_living_state_preview', 'csm_living_state_debug', 'csm_compaction_audit',
  'csm_recall_quality_report', 'csm_continuity_report', 'csm_reentry_preview',
  'create_checkpoint', 'expand_checkpoint_ref', 'list_checkpoints', 'context_review',
  'context_fetch', 'context_search', 'context_fetch_file_region', 'context_fetch_last_error',
  'context_fetch_decision_log', 'goal_set', 'goal_update', 'goal_list',
  'csm_work_ledger_surviving',
] as const;

export function registerTools(pluginCtx: PluginContext): Record<string, unknown> {
  const tools = createRegisteredToolList(pluginCtx);
  return guardToolsForSourceOnly(pluginCtx, removeSqliteUnsupportedTools(pluginCtx, tools));
}

function removeSqliteUnsupportedTools(
  pluginCtx: PluginContext,
  toolList: Record<string, unknown>,
): Record<string, unknown> {
  if (pluginCtx.config.databaseProvider !== 'sqlite') return toolList;
  for (const name of SQLITE_UNSUPPORTED_TOOLS) delete toolList[name];
  return toolList;
}

function guardToolsForSourceOnly(
  pluginCtx: PluginContext,
  toolList: Record<string, unknown>,
): Record<string, unknown> {
  for (const [name, definition] of Object.entries(toolList)) guardTool(pluginCtx, name, definition);
  return toolList;
}

function guardTool(pluginCtx: PluginContext, name: string, definition: unknown): void {
  if (!definition || typeof definition !== 'object' || !('execute' in definition)) return;
  const toolDefinition = definition as { execute?: unknown };
  if (typeof toolDefinition.execute !== 'function') return;
  const execute = toolDefinition.execute as ToolExecute;
  toolDefinition.execute = async (args: unknown, context?: ToolContext) => {
    if (!isReentrySourceOnlyActive(pluginCtx.state, context?.sessionID)) return execute(args, context);
    return blockedToolResult(name);
  };
}

type ToolContext = { sessionID?: string };
type ToolExecute = (args: unknown, context?: ToolContext) => Promise<unknown>;

function blockedToolResult(name: string) {
  return {
    title: 'Use re-entry context only',
    output: REENTRY_SOURCE_ONLY_RECOVERY_MESSAGE,
    metadata: { blocked: true, reason: 'reentry_source_only', tool: name },
  };
}

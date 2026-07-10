import {
  EXTRA_BRIDGE_TOOL_NAMES,
  type CodexBridgeExtraName,
} from './codex-bridge-extra-ops.js';

const CORE_TOOLS = [
  'save_memory', 'search_memories', 'list_memories',
  'get_context_brief', 'recall_lessons',
] as const;

const FULL_RUNTIME_TOOLS = [
  'bridge_resume_context', 'bridge_sync_turn', 'bridge_handoff_summary',
  'prune_memories_dry_run', 'backfill_missing_embeddings', 'get_compaction_report',
  'preview_teacher_traces', 'seed_teacher_traces', 'capture_trace_vault',
  'preview_trace_vault', 'seed_teacher_traces_from_vault',
  'work_ledger_begin', 'work_ledger_complete', 'work_ledger_surviving',
  'work_ledger_commit',
] as const;

const SQLITE_EXTRA_TOOLS: CodexBridgeExtraName[] = [
  'memory_transcript', 'memory_delete', 'memory_context', 'memory_lesson',
  'memory_project_list', 'memory_compact', 'csm_context_pressure',
  'csm_context_budget', 'csm_runtime_status',
];

export function bridgeToolNames(provider: string, workLedgerEnabled = true): string[] {
  if (provider === 'sqlite') return [...CORE_TOOLS, ...SQLITE_EXTRA_TOOLS];
  const runtimeTools = workLedgerEnabled
    ? FULL_RUNTIME_TOOLS
    : FULL_RUNTIME_TOOLS.filter((name) => !name.startsWith('work_ledger_'));
  return [...CORE_TOOLS, ...runtimeTools, ...EXTRA_BRIDGE_TOOL_NAMES];
}

export function assertFullBridgeRuntime(provider: string, operation: string): void {
  if (provider !== 'sqlite') return;
  throw new Error(`${operation} is unavailable in SQLite core-memory mode; use PostgreSQL full runtime.`);
}

export function assertWorkLedgerAvailable(
  provider: string,
  enabled: boolean,
  operation: string,
): void {
  assertFullBridgeRuntime(provider, operation);
  if (enabled) return;
  throw new Error(`${operation} is unavailable because the Work Ledger is disabled.`);
}

export function assertBridgeExtraSupported(provider: string, name: string): void {
  if (provider !== 'sqlite' || SQLITE_EXTRA_TOOLS.includes(name as CodexBridgeExtraName)) return;
  throw new Error(`${name} is unavailable in SQLite core-memory mode; use PostgreSQL full runtime.`);
}

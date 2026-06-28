import { CodexMemoryBridge } from './codex-bridge.js';
import type { MemoryListOptions, MemorySaveOptions, MemorySearchMode, MemorySearchOptions, MemoryType, SortBy } from './types.js';
import { VAULT_TOOL_SPECS, teacherTraceArgs, traceVaultArgs, traceVaultPreviewArgs } from './codex-mcp-vault-tools.js';

type ToolArgs = Record<string, unknown>;

const MEMORY_TYPES: MemoryType[] = ['conversation', 'workspace', 'repo', 'preference', 'lesson', 'episodic', 'procedural', 'self_continuity'];
const SEARCH_MODES: MemorySearchMode[] = ['project', 'legacy', 'global'];
const SORT_OPTIONS: SortBy[] = ['recent', 'important', 'accessed'];

export const MCP_TOOLS = [
  toolSpec('save_memory', 'Persist a memory row for the active project.', {
    content: { type: 'string', description: 'Memory content to save.' },
    type: { type: 'string', enum: MEMORY_TYPES, description: 'Memory type.' },
    projectRoot: { type: 'string', description: 'Project root or project identifier.' },
    sessionId: { type: 'string', description: 'Optional bridge session id.' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Optional memory tags.' },
    importance: { type: 'number', description: 'Optional importance score from 0 to 1.' },
  }, ['content', 'type']),
  toolSpec('search_memories', 'Search memories with bridge fallback behavior.', {
    query: { type: 'string', description: 'Search query.' },
    projectId: { type: 'string', description: 'Project id or root to search within.' },
    sessionId: { type: 'string', description: 'Optional bridge session id.' },
    limit: { type: 'number', description: 'Max result count.', default: 5 },
    searchMode: { type: 'string', enum: SEARCH_MODES, description: 'Search scope strategy.' },
  }, ['query']),
  toolSpec('list_memories', 'List recent or important memories for a project.', {
    projectId: { type: 'string', description: 'Project id or root to list from.' },
    sessionId: { type: 'string', description: 'Optional bridge session id.' },
    limit: { type: 'number', description: 'Max result count.', default: 10 },
    type: { type: 'string', enum: MEMORY_TYPES, description: 'Filter by memory type.' },
    sortBy: { type: 'string', enum: SORT_OPTIONS, description: 'Sort order.' },
    searchMode: { type: 'string', enum: SEARCH_MODES, description: 'Project, legacy, or global.' },
  }),
  toolSpec('get_context_brief', 'Build a compact context brief for a task.', {
    task: { type: 'string', description: 'Task to prime for.' },
    projectRoot: { type: 'string', description: 'Project root or identifier.' },
    sessionId: { type: 'string', description: 'Optional bridge session id.' },
  }, ['task']),
  toolSpec('recall_lessons', 'Recall lesson and procedural memories for a task.', {
    task: { type: 'string', description: 'Task to search against.' },
    projectRoot: { type: 'string', description: 'Project root or identifier.' },
    sessionId: { type: 'string', description: 'Optional bridge session id.' },
    limit: { type: 'number', description: 'Max lesson count.', default: 5 },
  }, ['task']),
  toolSpec('bridge_resume_context', 'Resume the bridge workflow with context brief plus recent memory.', {
    task: { type: 'string', description: 'Task being resumed.' },
    projectRoot: { type: 'string', description: 'Project root or identifier.' },
    sessionId: { type: 'string', description: 'Optional bridge session id.' },
    recentLimit: { type: 'number', description: 'Recent memory rows to include.', default: 5 },
  }, ['task']),
  toolSpec('bridge_sync_turn', 'Mirror a Codex turn into long-term memory and emit a bridge event.', {
    role: { type: 'string', enum: ['user', 'assistant', 'system'], description: 'Turn role.' },
    content: { type: 'string', description: 'Turn content to mirror.' },
    projectRoot: { type: 'string', description: 'Project root or identifier.' },
    sessionId: { type: 'string', description: 'Optional bridge session id.' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
    memoryType: { type: 'string', enum: MEMORY_TYPES, description: 'Override stored memory type.' },
  }, ['role', 'content']),
  toolSpec('bridge_handoff_summary', 'Build a handoff summary for the current bridge session.', {
    task: { type: 'string', description: 'Current or next task label.' },
    projectRoot: { type: 'string', description: 'Project root or identifier.' },
    sessionId: { type: 'string', description: 'Optional bridge session id.' },
    recentLimit: { type: 'number', description: 'Recent memory rows to include.', default: 5 },
  }),
  toolSpec('prune_memories_dry_run', 'Preview prune candidates without mutating data.', {}),
  toolSpec('backfill_missing_embeddings', 'Repair missing embeddings on demand.', {
    limit: { type: 'number', description: 'Max rows to scan.', default: 25 },
    projectId: { type: 'string', description: 'Optional project filter.' },
    dryRun: { type: 'boolean', description: 'Preview only without writing embeddings.' },
  }, ['limit']),
  toolSpec('get_compaction_report', 'Fetch the latest compaction metric for a session.', {
    sessionId: { type: 'string', description: 'Optional session id.' },
  }),
  ...VAULT_TOOL_SPECS,
];

export async function invokeMcpTool(bridge: CodexMemoryBridge, name: string, args: ToolArgs) {
  if (name === 'save_memory') return bridge.saveMemory(buildSaveInput(args));
  if (name === 'search_memories') return bridge.searchMemories(buildSearchInput(args));
  if (name === 'list_memories') return bridge.listMemories(buildListInput(args));
  if (name === 'get_context_brief') return bridge.getContextBrief(contextArgs(args));
  if (name === 'recall_lessons') return bridge.recallLessons(lessonArgs(args));
  if (name === 'bridge_resume_context') return bridge.resumeContext(resumeArgs(args));
  if (name === 'bridge_sync_turn') return bridge.syncTurn(syncArgs(args));
  if (name === 'bridge_handoff_summary') return bridge.getHandoffSummary(handoffArgs(args));
  if (name === 'prune_memories_dry_run') return bridge.pruneMemoriesDryRun();
  if (name === 'backfill_missing_embeddings') return bridge.backfillMissingEmbeddings(backfillArgs(args));
  if (name === 'get_compaction_report') return bridge.getCompactionReport(optionalString(args.sessionId));
  if (name === 'preview_teacher_traces') return bridge.previewTeacherTraces(teacherTraceArgs(args));
  if (name === 'seed_teacher_traces') return bridge.seedTeacherTraces(teacherTraceArgs(args));
  if (name === 'capture_trace_vault') return bridge.captureTraceVault(traceVaultArgs(args));
  if (name === 'preview_trace_vault') return bridge.previewTraceVault(traceVaultPreviewArgs(args));
  if (name === 'seed_teacher_traces_from_vault') return bridge.seedTeacherTracesFromVault(traceVaultPreviewArgs(args));
  throw new Error(`Unknown tool: ${name}`);
}

function toolSpec(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return { name, title: name, description, inputSchema: { type: 'object', properties, required } };
}

function buildSaveInput(args: ToolArgs): MemorySaveOptions & { projectRoot?: string; sessionId?: string } {
  return {
    content: requiredString(args.content, 'content'),
    type: requiredString(args.type, 'type') as MemoryType,
    projectRoot: defaultProject(args.projectRoot),
    sessionId: optionalString(args.sessionId),
    tags: stringArray(args.tags),
    importance: optionalNumber(args.importance),
  };
}

function buildSearchInput(args: ToolArgs): MemorySearchOptions & { sessionId?: string } {
  return {
    query: requiredString(args.query, 'query'),
    projectId: defaultProject(args.projectId),
    sessionId: optionalString(args.sessionId),
    limit: optionalNumber(args.limit) ?? 5,
    searchMode: optionalString(args.searchMode) as MemorySearchMode | undefined,
  };
}

function buildListInput(args: ToolArgs): MemoryListOptions & { sessionId?: string } {
  return {
    projectId: defaultProject(args.projectId),
    sessionId: optionalString(args.sessionId),
    limit: optionalNumber(args.limit) ?? 10,
    type: optionalString(args.type) as MemoryType | undefined,
    sortBy: optionalString(args.sortBy) as SortBy | undefined,
    searchMode: optionalString(args.searchMode) as MemorySearchMode | undefined,
  };
}

function contextArgs(args: ToolArgs) {
  return { task: requiredString(args.task, 'task'), projectRoot: defaultProject(args.projectRoot), sessionId: optionalString(args.sessionId) };
}

function lessonArgs(args: ToolArgs) {
  return { ...contextArgs(args), limit: optionalNumber(args.limit) ?? 5 };
}

function resumeArgs(args: ToolArgs) {
  return { ...contextArgs(args), recentLimit: optionalNumber(args.recentLimit) ?? 5 };
}

function syncArgs(args: ToolArgs) {
  return {
    role: requiredString(args.role, 'role') as 'user' | 'assistant' | 'system',
    content: requiredString(args.content, 'content'),
    projectRoot: defaultProject(args.projectRoot),
    sessionId: optionalString(args.sessionId),
    tags: stringArray(args.tags),
    memoryType: optionalString(args.memoryType) as MemoryType | undefined,
  };
}

function handoffArgs(args: ToolArgs) {
  return { task: optionalString(args.task) ?? 'handoff summary', projectRoot: defaultProject(args.projectRoot), sessionId: optionalString(args.sessionId), recentLimit: optionalNumber(args.recentLimit) ?? 5 };
}

function backfillArgs(args: ToolArgs) {
  return { limit: optionalNumber(args.limit) ?? 25, projectId: defaultProject(args.projectId), dryRun: args.dryRun === true };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be a non-empty string.`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

function defaultProject(value: unknown): string {
  return optionalString(value) ?? process.cwd().split(/[\\/]/).pop() ?? 'cross-session-memory';
}

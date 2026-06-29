import type { Database } from './database.js';
import type { ContextCompactor } from './context-compactor.js';
import type { ContextRecallDaemon } from './context-recall.js';
import type { MemoryManager } from './memory-manager.js';
import type { PrimingEngine } from './priming-engine.js';
import { rankMemoriesByProvenance } from './bridge-provenance.js';
import type { BackfillEmbeddingsResult, ContextBrief, Memory, MemorySaveOptions, MemorySearchOptions, PruneReport } from './types.js';

export interface BridgeDeps {
  database?: Database;
  memoryManager: MemoryManager;
  contextRecall: ContextRecallDaemon;
  primingEngine: PrimingEngine;
  contextCompactor: ContextCompactor;
}

export interface BridgeContext {
  projectId?: string;
  sessionId?: string;
}

export interface ContextBriefPayload {
  available: boolean;
  brief: ContextBrief | null;
  lessons: Memory[];
  activeRisks: Memory[];
}

export interface CompactionReportPayload {
  available: boolean;
  sessionId?: string;
  metric?: Record<string, unknown>;
  cumulative?: ReturnType<ContextCompactor['getCumulativeStats']>;
}

export async function saveMemoryOp(
  deps: BridgeDeps,
  input: MemorySaveOptions,
): Promise<Memory> {
  return deps.memoryManager.saveMemory(input);
}

export async function searchMemoriesOp(
  deps: BridgeDeps,
  input: MemorySearchOptions,
  context: BridgeContext = {},
): Promise<{ results: Awaited<ReturnType<MemoryManager['searchMemories']>>; cascaded: Memory[] }> {
  const projectId = input.projectId ?? context.projectId;
  const telemetry = context.sessionId ? { sessionId: context.sessionId, source: 'search' as const } : undefined;
  let results = await deps.memoryManager.searchMemories(
    { ...input, projectId, searchMode: input.searchMode ?? (projectId ? 'project' : 'global') },
    telemetry,
  );
  if (results.length === 0 && projectId) {
    results = await deps.memoryManager.searchMemories(
      { ...input, projectId, searchMode: 'legacy' },
      telemetry,
    );
  }
  if (results.length === 0 && projectId) {
    results = await deps.memoryManager.searchMemories(
      { ...input, projectId: undefined, searchMode: 'global' },
      telemetry,
    );
  }
  const ids = results.slice(0, 3).map((row) => row.memory.id);
  const cascaded = ids.length > 0
    ? (await deps.primingEngine.cascadeFromMultiple(ids)).memories
    : [];
  return { results, cascaded };
}

export async function listMemoriesOp(
  deps: BridgeDeps,
  input: Parameters<MemoryManager['listMemories']>[0] = {},
  context: BridgeContext = {},
): Promise<Memory[]> {
  const projectId = input.projectId ?? context.projectId;
  const telemetry = context.sessionId ? { sessionId: context.sessionId, source: 'list' as const } : undefined;
  let memories = await deps.memoryManager.listMemories(
    { ...input, projectId, searchMode: input.searchMode ?? (projectId ? 'project' : 'global') },
    telemetry,
  );
  if (memories.length === 0 && projectId) {
    memories = await deps.memoryManager.listMemories(
      { ...input, projectId, searchMode: 'legacy' },
      telemetry,
    );
  }
  if (memories.length === 0 && projectId) {
    memories = await deps.memoryManager.listMemories(
      { ...input, projectId: undefined, searchMode: 'global' },
      telemetry,
    );
  }
  return memories;
}

export async function recallLessonsOp(
  deps: BridgeDeps,
  task: string,
  context: BridgeContext = {},
  limit: number = 5,
): Promise<Memory[]> {
  const search = await searchMemoriesOp(deps, { query: task, limit: limit * 2, projectId: context.projectId }, context);
  const direct = search.results
    .map((row) => row.memory)
    .filter((memory) => memory.memoryType === 'lesson' || memory.memoryType === 'procedural');
  const fallback = await deps.memoryManager.listMemories({
    type: 'lesson',
    projectId: context.projectId,
    sortBy: 'important',
    limit,
  });
  return rankMemoriesByProvenance(uniqueMemories([...direct, ...fallback])).slice(0, limit);
}

export async function getContextBriefOp(
  deps: BridgeDeps,
  task: string,
  context: BridgeContext = {},
): Promise<ContextBriefPayload> {
  const brief = await deps.contextRecall.getContextBrief();
  if (!brief) {
    return { available: false, brief: null, lessons: [], activeRisks: [] };
  }
  const lessons = await recallLessonsOp(deps, task, context);
  const activeRisks = rankMemoriesByProvenance(uniqueMemories([
    ...lessons.filter(isRiskMemory),
    ...brief.procedural.filter(isRiskMemory),
  ])).slice(0, 5);
  return { available: true, brief, lessons, activeRisks };
}

export async function pruneMemoriesDryRunOp(
  deps: BridgeDeps,
): Promise<PruneReport> {
  return deps.memoryManager.pruneMemories({ dryRun: true });
}

export async function backfillMissingEmbeddingsOp(
  deps: BridgeDeps,
  limit: number,
  projectId?: string,
  dryRun?: boolean,
): Promise<BackfillEmbeddingsResult> {
  return deps.memoryManager.backfillMissingEmbeddings({ limit, projectId, dryRun });
}

export async function getCompactionReportOp(
  deps: BridgeDeps,
  sessionId?: string,
): Promise<CompactionReportPayload> {
  if (!deps.database) {
    throw new Error('Database is required for compaction reports');
  }
  const pool = deps.database.getPool();
  const metric = await pool.query(
    `SELECT id, session_id, created_at, total_tool_parts, compacted_parts, skipped_parts,
            before_tokens, after_tokens, tokens_saved, saved_percent, context_brief_chars
     FROM compaction_metrics
     WHERE ($1::text IS NULL OR session_id = $1)
     ORDER BY created_at DESC
     LIMIT 1`,
    [sessionId ?? null],
  );
  if (metric.rows.length === 0) {
    return {
      available: false,
      sessionId,
      cumulative: deps.contextCompactor.getCumulativeStats(),
    };
  }
  return {
    available: true,
    sessionId: String((metric.rows[0] as Record<string, unknown>).session_id),
    metric: metric.rows[0] as Record<string, unknown>,
    cumulative: deps.contextCompactor.getCumulativeStats(),
  };
}

function uniqueMemories(memories: Memory[]): Memory[] {
  const seen = new Set<number>();
  return memories.filter((memory) => {
    if (seen.has(memory.id)) return false;
    seen.add(memory.id);
    return true;
  });
}

function isRiskMemory(memory: Memory): boolean {
  const text = `${memory.content} ${(memory.tags ?? []).join(' ')}`.toLowerCase();
  return /risk|error|warning|fail|rollback|security/.test(text);
}

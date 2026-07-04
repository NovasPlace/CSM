import { getContextBriefOp } from './bridge-ops.js';
import type { CodexBridgeExtraDeps } from './codex-bridge-extra-ops.js';
import type { Database } from './database.js';
import { ToolCallDistiller } from './tool-distiller.js';
import type { ToolCallRecord } from './types.js';
import { asLimit, asRecord, asString, asStringArray, requireSession, requireString } from './codex-bridge-extra-utils.js';

export async function memoryTranscriptOp(memoryManager: CodexBridgeExtraDeps['memoryManager'], sessionId: string | undefined, input: Record<string, unknown>) {
  const sid = requireSession(sessionId);
  const memories = await memoryManager.listMemories({ type: 'conversation', limit: asLimit(input.limit, 50), sortBy: 'recent', sessionId: sid });
  const role = asString(input.role) ?? 'all';
  return { sessionId: sid, count: memories.filter((m) => m.sessionId === sid && (role === 'all' || (m.metadata?.role as string | undefined) === role)).length, transcript: memories };
}

export async function memoryDeleteOp(memoryManager: CodexBridgeExtraDeps['memoryManager'], id: unknown) {
  return { deleted: await memoryManager.deleteMemory(Number(requireString(id, 'id'))) };
}

export async function memoryContextOp(deps: CodexBridgeExtraDeps, sessionId: string | undefined, input: Record<string, unknown>) {
  const sid = requireSession(sessionId);
  return {
    sessionId: sid,
    task: asString(input.task) ?? 'memory context',
    brief: await getContextBriefOp(deps, asString(input.task) ?? 'memory context', { projectId: asString(input.projectRoot) ?? sid, sessionId: sid }),
  };
}

export async function memoryLessonOp(memoryManager: CodexBridgeExtraDeps['memoryManager'], sessionId: string | undefined, input: Record<string, unknown>) {
  const sid = requireSession(sessionId);
  return {
    memory: await memoryManager.saveMemory({
      content: requireString(input.content, 'content'),
      type: 'lesson',
      importance: 0.75,
      emotion: 'frustration',
      confidence: 0.9,
      source: 'lesson',
      tags: asStringArray(input.tags) ?? ['lesson'],
      metadata: asRecord(input.context),
      sessionId: sid,
    }),
  };
}

export async function memoryProjectListOp(memoryManager: CodexBridgeExtraDeps['memoryManager']) {
  return { projects: await memoryManager.getAllProjectScopes() };
}

export async function memoryCleanupOp(memoryManager: CodexBridgeExtraDeps['memoryManager']) {
  return memoryManager.cleanupExpiredMemories();
}

export async function memoryBackfillOp(memoryManager: CodexBridgeExtraDeps['memoryManager'], input: Record<string, unknown>) {
  return memoryManager.backfillMissingEmbeddings({ limit: asLimit(input.limit, 25), projectId: asString(input.projectRoot) ?? asString(input.projectId), dryRun: input.dryRun === true });
}

export async function memoryDistilledViewOp(database: Database, sessionId: string | undefined, input: Record<string, unknown>) {
  const sid = requireSession(sessionId);
  const result = await database.getPool().query(
    `SELECT id, compressed, total_calls_summarized, built_at FROM distilled_summaries WHERE session_id = $1 ORDER BY built_at DESC LIMIT $2`,
    [sid, asLimit(input.limit, 5)],
  );
  return { sessionId: sid, summaries: result.rows };
}

export function memoryCompactOp(deps: CodexBridgeExtraDeps) {
  return { lastResult: deps.contextCompactor.getLastResult(), cumulative: deps.contextCompactor.getCumulativeStats() };
}

export async function memoryDistillOp(deps: CodexBridgeExtraDeps, sessionId: string | undefined, input: Record<string, unknown>) {
  const sid = requireSession(sessionId);
  const calls = normalizeToolCalls(input.calls);
  if (calls.length < 2) return { summary: null, extractedCandidates: 0, reason: 'at least two tool calls are required' };
  const distiller = new ToolCallDistiller(deps.distillerConfig);
  for (const call of calls) distiller.record(call);
  const summary = distiller.distill();
  if (summary.groups.length === 0) return { summary, extractedCandidates: 0, reason: 'no groups met the distillation threshold' };
  const redactor = deps.memoryManager.redactor;
  const compressed = redactor ? redactor.redact(summary.compressed).text : summary.compressed;
  const groupsText = redactor ? redactor.redact(JSON.stringify(summary.groups)).text : JSON.stringify(summary.groups);
  await deps.database.getPool().query(
    `INSERT INTO distilled_summaries (id, session_id, groups, compressed, total_calls_summarized) VALUES ($1, $2, $3, $4, $5)`,
    [summary.id, sid, groupsText, compressed, summary.totalCallsSummarized],
  );
  const extracted = input.extractMemories === false ? [] : await deps.memoryExtractor.extractFromDistilledSummaries(sid, asString(input.projectRoot) ?? sid, summary);
  return { summary, extractedCandidates: extracted.length };
}

export async function reviewCandidateOp(memoryExtractor: CodexBridgeExtraDeps['memoryExtractor'], name: 'memory_candidate_approve' | 'memory_candidate_reject', input: Record<string, unknown>, sessionId: string | undefined) {
  const sid = requireSession(sessionId);
  const candidateId = requireString(input.id, 'id');
  const approval = name === 'memory_candidate_approve'
    ? { candidateId, action: 'approve' as const, editedContent: asString(input.editedContent), editedType: asString(input.editedType) as any, editedImportance: typeof input.editedImportance === 'number' ? input.editedImportance : undefined, editedTags: asStringArray(input.editedTags), reviewedBy: 'user' as const, reviewedAt: new Date() }
    : { candidateId, action: 'reject' as const, reviewedBy: 'user' as const, reviewedAt: new Date() };
  await memoryExtractor.reviewCandidate(approval, 'user');
  return { sessionId: sid, candidateId, action: approval.action };
}

function normalizeToolCalls(value: unknown): ToolCallRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ToolCallRecord => {
    if (!item || typeof item !== 'object') return false;
    const call = item as Record<string, unknown>;
    return typeof call.tool === 'string' && typeof call.output === 'string' && typeof call.timestamp === 'number' && typeof call.sessionId === 'string' && typeof call.args === 'object' && call.args !== null;
  }).map((item) => item as ToolCallRecord);
}

import { getContextBriefOp } from './bridge-ops.js';
import type { CodexBridgeExtraDeps } from './codex-bridge-extra-ops.js';
import type { Database } from './database.js';
import { ToolCallDistiller } from './tool-distiller.js';
import type { MemoryType, TTLConfig, ToolCallRecord } from './types.js';
import { asLimit, asRecord, asString, asStringArray, requireSession, requireString } from './codex-bridge-extra-utils.js';
import { withBridgeProvenance } from './bridge-provenance.js';
import { Redactor, redactJsonValue } from './redactor.js';

export async function memoryTranscriptOp(memoryManager: CodexBridgeExtraDeps['memoryManager'], sessionId: string | undefined, input: Record<string, unknown>) {
  const sid = requireSession(sessionId);
  const projectId = requireString(input.projectRoot, 'projectRoot');
  const memories = await memoryManager.listMemories({
    type: 'conversation',
    projectId,
    searchMode: 'project',
    limit: asLimit(input.limit, 50),
    sortBy: 'recent',
    sessionId: sid,
  });
  const role = asString(input.role) ?? 'all';
  return { sessionId: sid, count: memories.filter((m) => m.sessionId === sid && (role === 'all' || (m.metadata?.role as string | undefined) === role)).length, transcript: memories };
}

// `memory_delete`'s MCP schema declares `id` as a number, but this called
// requireString() -- so any schema-validating client (e.g. Claude Code) could
// never invoke the tool. Accept either form and validate it is a real id.
function requireMemoryId(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  if (!Number.isInteger(n) || n <= 0) throw new Error('id must be a positive integer memory id.');
  return n;
}

export async function memoryDeleteOp(
  memoryManager: CodexBridgeExtraDeps['memoryManager'],
  id: unknown,
  projectRoot: unknown,
) {
  return {
    deleted: await memoryManager.deleteMemory(
      requireMemoryId(id),
      requireString(projectRoot, 'projectRoot'),
    ),
  };
}

export async function memoryContextOp(deps: CodexBridgeExtraDeps, sessionId: string | undefined, input: Record<string, unknown>) {
  const sid = requireSession(sessionId);
  return {
    sessionId: sid,
    task: asString(input.task) ?? 'memory context',
    brief: await getContextBriefOp(deps, asString(input.task) ?? 'memory context', { projectId: asString(input.projectRoot) ?? sid, sessionId: sid }),
  };
}

/** Caller-supplied `context` must never dictate provenance: strip source_* / evidence keys
 *  so the MCP clientInfo handshake stays the only authority. */
function stripProvenanceKeys(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return meta;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (key.startsWith('source_') || key === 'evidence_strength' || key === 'derivative_of') continue;
    out[key] = value;
  }
  return out;
}

export async function memoryLessonOp(memoryManager: CodexBridgeExtraDeps['memoryManager'], sessionId: string | undefined, input: Record<string, unknown>) {
  const sid = requireSession(sessionId);
  return {
    memory: await memoryManager.saveMemory(withBridgeProvenance({
      content: requireString(input.content, 'content'),
      type: 'lesson',
      importance: 0.75,
      emotion: 'frustration',
      confidence: 0.9,
      source: 'lesson',
      tags: asStringArray(input.tags) ?? ['lesson'],
      metadata: stripProvenanceKeys(asRecord(input.context)),
      sessionId: sid,
    }, { sessionId: sid, projectRoot: asString(input.projectRoot) ?? sid, sourceKind: 'user_supplied' })),
  };
}

export async function memoryProjectListOp(memoryManager: CodexBridgeExtraDeps['memoryManager']) {
  return { projects: await memoryManager.getAllProjectScopes() };
}

export async function memoryCleanupOp(
  memoryManager: CodexBridgeExtraDeps['memoryManager'],
  ttl: TTLConfig,
  input: Record<string, unknown>,
) {
  return memoryManager.cleanupExpiredMemories({
    projectId: requireString(input.projectRoot, 'projectRoot'),
    ttl,
    apply: input.apply === true,
    maxDelete: cleanupLimit(input.maxDelete),
  });
}

function cleanupLimit(value: unknown): number {
  if (value === undefined) return 1_000;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 10_000) {
    throw new Error('maxDelete must be an integer between 1 and 10000');
  }
  return value as number;
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
  const redactor = deps.memoryManager.redactor ?? new Redactor();
  const safeSummary = {
    ...summary,
    groups: redactJsonValue(redactor, summary.groups),
    compressed: redactor.redact(summary.compressed).text,
  };
  await deps.database.getPool().query(
    `INSERT INTO distilled_summaries (id, session_id, groups, compressed, total_calls_summarized) VALUES ($1, $2, $3, $4, $5)`,
    [safeSummary.id, sid, JSON.stringify(safeSummary.groups), safeSummary.compressed, safeSummary.totalCallsSummarized],
  );
  const extracted = input.extractMemories === false ? [] : await deps.memoryExtractor.extractFromDistilledSummaries(sid, asString(input.projectRoot) ?? sid, safeSummary);
  return { summary: safeSummary, extractedCandidates: extracted.length };
}

export async function reviewCandidateOp(memoryExtractor: CodexBridgeExtraDeps['memoryExtractor'], name: 'memory_candidate_approve' | 'memory_candidate_reject', input: Record<string, unknown>, sessionId: string | undefined) {
  const sid = requireSession(sessionId);
  const candidateId = requireString(input.id, 'id');
  const approval = name === 'memory_candidate_approve'
    ? { candidateId, action: 'approve' as const, editedContent: asString(input.editedContent), editedType: asString(input.editedType) as MemoryType | undefined, editedImportance: typeof input.editedImportance === 'number' ? input.editedImportance : undefined, editedTags: asStringArray(input.editedTags), reviewedBy: 'user' as const, reviewedAt: new Date() }
    : { candidateId, action: 'reject' as const, reviewedBy: 'user' as const, reviewedAt: new Date() };
  await memoryExtractor.reviewCandidate(approval, 'user', sid);
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

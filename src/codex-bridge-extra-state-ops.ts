import { ContextPressure } from './context-pressure.js';
import { buildCheckpoint } from './checkpoint-builder.js';
import type { SessionMessage } from './checkpoint-types.js';
import { getRecentCompilation } from './context-compilation-log.js';
import { fetchDecisions, fetchFileReads, fetchItem, fetchLastError, searchItems } from './context-cache-store.js';
import type { CodexBridgeExtraDeps } from './codex-bridge-extra-ops.js';
import { auditCompactionTelemetry, formatAuditReport } from './compaction-telemetry-audit.js';
import { getActiveGoal, listGoals, setActiveGoal, updateGoal } from './goal-schema.js';
import type { Goal } from './goal-schema.js';
import { asLimit, asMessages, asNumber, asRecord, asString, requireSession, requireString } from './codex-bridge-extra-utils.js';
import { CSM_TOOL_NAMES } from './tool-names.js';

export async function contextFetchOp(deps: CodexBridgeExtraDeps, sessionId: string | undefined, input: Record<string, unknown>) {
  return { item: await fetchItem(deps.database.getPool(), requireSession(sessionId), requireString(input.id, 'id')) };
}

export async function contextSearchOp(deps: CodexBridgeExtraDeps, sessionId: string | undefined, input: Record<string, unknown>) {
  return { items: await searchItems(deps.database.getPool(), requireSession(sessionId), requireString(input.query, 'query'), asLimit(input.limit, 10)) };
}

export async function contextFetchFileRegionOp(deps: CodexBridgeExtraDeps, sessionId: string | undefined, input: Record<string, unknown>) {
  const reads = await fetchFileReads(deps.database.getPool(), requireSession(sessionId), requireString(input.filePath, 'filePath'));
  const latest = reads[0];
  if (!latest) return { found: false, filePath: input.filePath };
  const lines = latest.content.split('\n');
  const startLine = asNumber(input.startLine, 1);
  const endLine = asNumber(input.endLine, startLine + 50);
  return { found: true, filePath: input.filePath, displayId: latest.displayId, region: lines.slice(startLine - 1, endLine).join('\n') };
}

export async function contextFetchLastErrorOp(deps: CodexBridgeExtraDeps, sessionId: string | undefined) {
  return { item: await fetchLastError(deps.database.getPool(), requireSession(sessionId)) };
}

export async function contextFetchDecisionLogOp(deps: CodexBridgeExtraDeps, sessionId: string | undefined, input: Record<string, unknown>) {
  return { items: await fetchDecisions(deps.database.getPool(), requireSession(sessionId), asLimit(input.limit, 10)) };
}

export async function goalSetOp(deps: CodexBridgeExtraDeps, sessionId: string | undefined, input: Record<string, unknown>) {
  return setActiveGoal(deps.database.getPool(), requireSession(sessionId), requireString(input.description, 'description'), asRecord(input.context));
}

export async function goalUpdateOp(deps: CodexBridgeExtraDeps, sessionId: string | undefined, input: Record<string, unknown>) {
  const sid = requireSession(sessionId);
  const goalId = asString(input.goalId) ?? (await getActiveGoal(deps.database.getPool(), sid))?.id;
  if (!goalId) return { found: false };
  return updateGoal(deps.database.getPool(), goalId, { description: asString(input.description) ?? undefined, status: asString(input.status) as Goal['status'], context: asRecord(input.context) });
}

export async function goalListOp(deps: CodexBridgeExtraDeps, sessionId: string | undefined, input: Record<string, unknown>) {
  return { goals: await listGoals(deps.database.getPool(), requireSession(sessionId), { status: asString(input.status), limit: asLimit(input.limit, 10) }) };
}

export async function createCheckpointOp(deps: CodexBridgeExtraDeps, sessionId: string | undefined, input: Record<string, unknown>) {
  const sid = requireSession(sessionId);
  const messages = Array.isArray(input.messages) ? input.messages : [];
  if (messages.length === 0) return { created: false, reason: 'messages_required' };
  const built = buildCheckpoint({ sessionId: sid, projectId: asString(input.projectRoot) ?? sid, messages: messages as SessionMessage[], config: deps.checkpointConfig });
  return { created: true, checkpoint: await deps.checkpointStore.createCheckpoint(built.checkpoint), build: built };
}

export async function listCheckpointsOp(deps: CodexBridgeExtraDeps, sessionId: string | undefined, input: Record<string, unknown>) {
  return { checkpoints: await deps.checkpointStore.listCheckpoints(requireSession(sessionId), asLimit(input.limit, 20)) };
}

export async function expandCheckpointRefOp(deps: CodexBridgeExtraDeps, sessionId: string | undefined, input: Record<string, unknown>) {
  return deps.checkpointStore.expandRef(requireSession(sessionId), requireString(input.refId, 'refId'));
}

export async function contextReviewOp(deps: CodexBridgeExtraDeps, sessionId: string | undefined, input: Record<string, unknown>) {
  const entry = await getRecentCompilation(deps.database.getPool(), requireSession(sessionId));
  return entry ? { available: true, sessionId, entry, detail: asString(input.detail) ?? 'summary' } : { available: false, sessionId };
}

export async function contextPressureOp(_deps: CodexBridgeExtraDeps, input: Record<string, unknown>) {
  const messages = asMessages(input.messages);
  const maxTokens = asNumber(input.maxTokens, 128000);
  const pressure = new ContextPressure(asNumber(input.recommendThreshold, 0.65), asNumber(input.demandThreshold, 0.85), maxTokens);
  const reading = pressure.tick(messages);
  const projectedNextTurnTokens = reading.estimatedTokens + asNumber(input.nextTurnTokens, 2000);
  return {
    ...reading,
    maxTokens,
    messageCount: messages.length,
    projectedNextTurnTokens,
    recommendedAction: pressure.getRecommendedAction(),
  };
}

export async function runtimeStatusOp(deps: CodexBridgeExtraDeps, sessionId?: string) {
  let databaseConnected = false;
  let postgresMemoryCount = 0;
  const contextWindowTokens = 128000;
  try {
    const countResult = await deps.database.getPool().query('SELECT COUNT(*) as count FROM memories');
    databaseConnected = true;
    postgresMemoryCount = parseInt(String((countResult.rows[0] as Record<string, unknown>).count ?? 0), 10);
   } catch (_e) {
     // Database not available, skip memory count
   }
  return {
    plugin_loaded: true,
    database_connected: databaseConnected,
    registered_csm_tools: CSM_TOOL_NAMES,
    tool_namespace: 'csm_',
    postgres_memory_count: postgresMemoryCount,
    current_session_id: sessionId ?? null,
    memory_runtime_enabled: true,
    context_window_tokens: contextWindowTokens,
    context_pressure_tool: 'csm_context_pressure',
  };
}

export async function compactionAuditOp(deps: CodexBridgeExtraDeps) {
  return { output: formatAuditReport(await auditCompactionTelemetry(deps.database.getPool())) };
}

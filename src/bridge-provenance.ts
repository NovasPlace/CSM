import { ProvenanceAwareContextGovernor } from './native-system-context-integration.js';
import type { GovernanceEligibility, MemoryRecord } from './native-system-context-types.js';
import type { Memory, MemorySaveOptions } from './types.js';

const governor = new ProvenanceAwareContextGovernor();

const ELIGIBILITY_SCORE: Record<GovernanceEligibility, number> = {
  governance_eligible: 4,
  context_only: 3,
  inferred_only: 2,
  gap_record: 1,
};

export interface BridgeProvenanceSummary {
  governanceEligibleCount: number;
  contextOnlyCount: number;
  inferredCount: number;
  gapCount: number;
}

/**
 * Identity of the MCP client attached to this process, captured from the
 * `initialize` handshake. Falls back to the historical Codex defaults when no
 * client announced itself (e.g. the in-process Codex plugin runtime), so
 * existing behaviour is preserved.
 */
let clientIdentity: { surface?: string; agentId?: string } = {};

/** Cowork announces `local-agent-mode-<serverName>` — a per-connection string,
 *  not a stable agent identity. Collapse it to one surface. */
function normalizeSurface(name: string): string {
  return name.startsWith('local-agent-mode-') ? 'cowork' : name;
}

export function setClientIdentity(info?: { name?: string; version?: string }): void {
  const name = info?.name?.trim();
  if (!name) return;
  clientIdentity = {
    surface: normalizeSurface(name),
    agentId: info?.version ? `${name}@${info.version}` : name,
  };
}

export function getClientIdentity(): { surface?: string; agentId?: string } {
  return { ...clientIdentity };
}

export function rankMemoriesByProvenance(memories: Memory[]): Memory[] {
  return [...memories].sort(compareMemories);
}

export function summarizeMemoryProvenance(memories: Memory[]): BridgeProvenanceSummary {
  const counts: BridgeProvenanceSummary = {
    governanceEligibleCount: 0,
    contextOnlyCount: 0,
    inferredCount: 0,
    gapCount: 0,
  };
  for (const memory of memories) bumpCount(counts, classifyMemory(memory));
  return counts;
}

export function withBridgeProvenance(
  input: MemorySaveOptions,
  context: { sessionId?: string; projectRoot?: string; sourceKind?: string },
): MemorySaveOptions {
  return {
    ...input,
    metadata: buildBridgeProvenanceMetadata(input.metadata, context),
  };
}

export function buildBridgeProvenanceMetadata(
  metadata: Record<string, unknown> | undefined,
  context: { sessionId?: string; projectRoot?: string; sourceKind?: string },
): Record<string, unknown> {
  const current = metadata ?? {};
  return {
    source_kind: current.source_kind ?? context.sourceKind ?? 'user_supplied',
    evidence_strength: current.evidence_strength ?? 'direct_original',
    source_session_id: current.source_session_id ?? context.sessionId,
    source_agent_id: current.source_agent_id ?? clientIdentity.agentId ?? 'codex-bridge',
    source_model_id: current.source_model_id,
    source_surface: current.source_surface ?? clientIdentity.surface ?? 'codex',
    project_root: current.project_root ?? context.projectRoot,
    ...current,
  };
}

function compareMemories(left: Memory, right: Memory): number {
  const rankDelta = provenanceScore(right) - provenanceScore(left);
  if (rankDelta !== 0) return rankDelta;
  const importanceDelta = right.importance - left.importance;
  if (importanceDelta !== 0) return importanceDelta;
  return right.createdAt.getTime() - left.createdAt.getTime();
}

function provenanceScore(memory: Memory): number {
  const check = governor.checkGovernanceCompleteness(toMemoryRecord(memory));
  return ELIGIBILITY_SCORE[check.eligibility];
}

function classifyMemory(memory: Memory): GovernanceEligibility {
  return governor.checkGovernanceCompleteness(toMemoryRecord(memory)).eligibility;
}

function toMemoryRecord(memory: Memory): MemoryRecord {
  const metadata = memory.metadata ?? {};
  return {
    ...memory,
    source_kind: asOptionalString(metadata.source_kind),
    evidence_strength: asOptionalString(metadata.evidence_strength),
    source_session_id: asOptionalString(metadata.source_session_id) ?? memory.sessionId,
    source_agent_id: asOptionalString(metadata.source_agent_id),
    source_model_id: asOptionalString(metadata.source_model_id),
    source_surface: asOptionalString(metadata.source_surface),
    derivative_of: asOptionalString(metadata.derivative_of),
  };
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function bumpCount(
  counts: BridgeProvenanceSummary,
  eligibility: GovernanceEligibility,
): void {
  if (eligibility === 'governance_eligible') counts.governanceEligibleCount += 1;
  if (eligibility === 'context_only') counts.contextOnlyCount += 1;
  if (eligibility === 'inferred_only') counts.inferredCount += 1;
  if (eligibility === 'gap_record') counts.gapCount += 1;
}

import type { DatabasePool } from './types.js';

export interface GovernanceVeto {
  memoryId: number;
  failureMode: string;
  vetoAction: string;
  requiredAction: string;
  content: string;
  importance: number;
  confidence: number;
  stalenessMs: number;
  sourceSessionId: string | null;
  provenanceVerified: boolean;
}

export interface GovernanceEvaluateResult {
  vetoes: GovernanceVeto[];
  accessed: boolean;
  accessLog: GovernanceAccessLogEntry[];
}

export interface GovernanceAccessLogEntry {
  memoryId: number;
  accessedAt: string;
  accessType: 'direct_db_query';
  stalenessMs: number;
  confidence: number;
}

export interface GovernanceDecision {
  vetoId: number;
  vetoAction: string;
  requiredAction: string;
  agentAction: string;
  constrained: boolean;
  evidenceCited: string;
}

const STALENESS_WARNING_MS = 86_400_000;
const STALENESS_MAX_MS = 7 * STALENESS_WARNING_MS;

export class MemoryGovernance {
  constructor(
    private readonly pool: DatabasePool,
  ) {}

  async evaluate(): Promise<GovernanceEvaluateResult> {
    const accessLog: GovernanceAccessLogEntry[] = [];
    let accessed = false;

    try {
      const result = await this.pool.query(
        `SELECT id, content, importance, metadata, session_id, created_at, confidence
         FROM memories
         WHERE memory_type = 'lesson'
           AND importance >= 0.7
           AND metadata ? 'governance'
         ORDER BY importance DESC, created_at DESC
         LIMIT 50`,
      );

      accessed = true;
      const now = Date.now();
      const vetoes: GovernanceVeto[] = [];

      for (const row of result.rows as any[]) {
        const gov = row.metadata?.governance ?? {};
        if (!gov.failure_mode || !gov.veto_action || !gov.required_action) continue;
        if (hasNonGovernanceProvenance(row.metadata)) continue;

        const createdMs = new Date(row.created_at).getTime();
        const stalenessMs = now - createdMs;

        accessLog.push({
          memoryId: row.id,
          accessedAt: new Date().toISOString(),
          accessType: 'direct_db_query',
          stalenessMs,
          confidence: row.confidence ?? 0.7,
        });

        vetoes.push({
          memoryId: row.id,
          failureMode: gov.failure_mode,
          vetoAction: gov.veto_action,
          requiredAction: gov.required_action,
          content: row.content,
          importance: row.importance,
          confidence: row.confidence ?? 0.7,
          stalenessMs,
          sourceSessionId: row.session_id ?? null,
          provenanceVerified: hasGovernanceProvenance(row.metadata),
        });
      }

      return { vetoes, accessed, accessLog };
    } catch {
      return { vetoes: [], accessed, accessLog };
    }
  }

  buildVetoInjection(vetoes: GovernanceVeto[]): string | null {
    if (vetoes.length === 0) return null;

    const lines: string[] = [
      '<memory_governance>',
      '',
      'The following governance vetoes are ACTIVE enforcement directives from prior sessions.',
      'Records without direct provenance are legacy/unverified source records with degraded authority.',
      'You MUST comply with these vetoes. They are not suggestions — they override default behavior.',
      '',
    ];

    for (const veto of vetoes) {
      const staleness = this.classifyStaleness(veto.stalenessMs);
      const stalenessLabel = staleness === 'fresh' ? '' 
        : staleness === 'stale' ? ' [STALE — downgrade to advisory]' 
        : ' [EXPIRED — informational only]';

      lines.push(`### Veto #${veto.memoryId}${stalenessLabel}`);
      lines.push(`- failure_mode: ${veto.failureMode}`);
      lines.push(`- veto_action: ${veto.vetoAction}`);
      lines.push(`- required_action: ${veto.requiredAction}`);
      lines.push(`- confidence: ${veto.confidence.toFixed(2)}`);
      lines.push(`- provenance: ${veto.provenanceVerified ? 'direct' : 'unverified source'}`);
      if (veto.sourceSessionId) {
        lines.push(`- source_session: ${veto.sourceSessionId.slice(0, 8)}`);
      }
      lines.push('');
    }

    lines.push('COMPLIANCE RULES:');
    lines.push('1. If a veto matches the action you are about to take, you MUST NOT take that action.');
    lines.push('2. Instead, perform the required_action specified in the veto.');
    lines.push('3. Cite the veto by memory ID (e.g., "Veto #42") when explaining why you changed behavior.');
    lines.push('4. STALE vetoes are advisory — comply if possible but state you are working from degraded authority.');
    lines.push('5. EXPIRED vetoes are informational only — acknowledge them but follow your own judgment.');
    lines.push('');
    lines.push('</memory_governance>');

    return lines.join('\n');
  }

  classifyDecision(
    vetoes: GovernanceVeto[],
    proposedAction: string,
    actualAction: string,
  ): GovernanceDecision[] {
    const decisions: GovernanceDecision[] = [];

    for (const veto of vetoes) {
      const staleness = this.classifyStaleness(veto.stalenessMs);
      const matches = proposedAction.toLowerCase().includes(veto.vetoAction.toLowerCase())
        || actualAction.toLowerCase().includes(veto.vetoAction.toLowerCase());

      if (!matches) continue;

      const constrained = staleness === 'fresh'
        ? !actualAction.toLowerCase().includes(veto.vetoAction.toLowerCase())
        : staleness === 'stale'
          ? !actualAction.toLowerCase().includes(veto.vetoAction.toLowerCase())
          : false;

      decisions.push({
        vetoId: veto.memoryId,
        vetoAction: veto.vetoAction,
        requiredAction: veto.requiredAction,
        agentAction: actualAction,
        constrained,
        evidenceCited: constrained ? `Memory #${veto.memoryId}` : '',
      });
    }

    return decisions;
  }

  private classifyStaleness(stalenessMs: number): 'fresh' | 'stale' | 'expired' {
    if (stalenessMs < STALENESS_WARNING_MS) return 'fresh';
    if (stalenessMs < STALENESS_MAX_MS) return 'stale';
    return 'expired';
  }
}

function hasGovernanceProvenance(metadata: any): boolean {
  const sourceKind = metadata?.source_kind;
  const evidence = metadata?.evidence_strength;
  return ['transcript', 'tool_trace', 'file_diff', 'user_supplied'].includes(sourceKind)
    && evidence === 'direct_original';
}

function hasNonGovernanceProvenance(metadata: any): boolean {
  if (!metadata?.source_kind && !metadata?.evidence_strength) return false;
  return !hasGovernanceProvenance(metadata);
}

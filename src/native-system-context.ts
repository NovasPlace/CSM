import type {
  CategorizedContextRecord,
  MemoryRecord,
  NativeContextIntegration as NativeContextIntegrationType,
  NativeContextSourceOutput,
  ProvenanceCompletenessCheck,
  ProvenanceFilterResult,
} from './native-system-context-types.js';

export class NativeSystemContextSource {
  static applyProvenanceFilter(
    records: MemoryRecord[],
    checkGovernanceCompleteness: (record: MemoryRecord) => ProvenanceCompletenessCheck,
  ): ProvenanceFilterResult {
    const result: ProvenanceFilterResult = {
      governance_eligible: [],
      context_only: [],
      inferred_only: [],
      gaps: [],
      blocked: [],
    };

    for (const record of records) {
      const check = checkGovernanceCompleteness(record);
      const categorized = categorizeRecord(record, check);

      if (check.eligibility === 'governance_eligible') {
        result.governance_eligible.push(categorized);
      } else if (check.eligibility === 'context_only') {
        result.context_only.push(categorized);
      } else if (check.eligibility === 'inferred_only') {
        result.inferred_only.push(categorized);
      } else {
        result.gaps.push(categorized);
        result.blocked.push(categorized);
      }
    }

    return result;
  }

  static generateContext(
    records: MemoryRecord[],
    checkGovernanceCompleteness: (record: MemoryRecord) => ProvenanceCompletenessCheck,
  ): NativeContextSourceOutput {
    const filterResult = this.applyProvenanceFilter(records, checkGovernanceCompleteness);
    return {
      governance_eligible_section: 'The following records can constrain future behavior (governance_eligible):',
      governance_records: filterResult.governance_eligible,
      context_only_section: 'The following records provide context but cannot constrain (context_only):',
      context_records: filterResult.context_only,
      inferred_section: 'Inferred signals from patterns (inferred):',
      inferred_records: filterResult.inferred_only,
      gaps_section: 'Missing provenance (for audit/improvement):',
      gap_records: filterResult.gaps,
      blocked_section: 'Blocked governance records (cannot veto):',
      blocked_records: filterResult.blocked,
      metadata: buildMetadata(records.length, filterResult),
    };
  }

  static createGovernanceConstraint(record: CategorizedContextRecord): string {
    return `Governance constraint from ${record.source_kind}: ${record.record.content?.substring(0, 100)}...`;
  }

  static createContextStatement(record: CategorizedContextRecord): string {
    return `Context from ${record.source_kind}: ${record.record.content?.substring(0, 100)}...`;
  }

  static createGapStatement(record: CategorizedContextRecord): string {
    return `Gap: ${record.gap_reason || 'Missing provenance information'}`;
  }

  static createBlockedStatement(record: CategorizedContextRecord): string {
    return `Blocked: ${record.source_kind} without sufficient provenance`;
  }
}

export const NativeContextIntegration: NativeContextIntegrationType = {
  useNativeSystemContext(records, checkGovernanceCompleteness) {
    return NativeSystemContextSource.generateContext(records, checkGovernanceCompleteness);
  },

  filterForGovernance(records: MemoryRecord[]): CategorizedContextRecord[] {
    return NativeSystemContextSource.applyProvenanceFilter(records, alwaysGovernance).governance_eligible;
  },

  filterForContext(records: MemoryRecord[]): CategorizedContextRecord[] {
    return NativeSystemContextSource.applyProvenanceFilter(records, alwaysContext).context_only;
  },

  generateGovernanceConstraints(records, checkGovernanceCompleteness) {
    const filtered = NativeSystemContextSource.applyProvenanceFilter(records, checkGovernanceCompleteness);
    return filtered.governance_eligible.map(NativeSystemContextSource.createGovernanceConstraint);
  },

  generateContextStatements(records, checkGovernanceCompleteness) {
    const filtered = NativeSystemContextSource.applyProvenanceFilter(records, checkGovernanceCompleteness);
    return filtered.context_only.map(NativeSystemContextSource.createContextStatement);
  },
};

function categorizeRecord(
  record: MemoryRecord,
  check: ProvenanceCompletenessCheck,
): CategorizedContextRecord {
  return {
    record,
    eligibility: check.eligibility,
    source_kind: record.source_kind || 'unknown',
    evidence_strength: record.evidence_strength || 'gap',
    derivative_of: record.derivative_of,
    gap_reason: check.gap_reason,
  };
}

function buildMetadata(total: number, result: ProvenanceFilterResult): NativeContextSourceOutput['metadata'] {
  return {
    total_records: total,
    governance_eligible_count: result.governance_eligible.length,
    context_only_count: result.context_only.length,
    inferred_count: result.inferred_only.length,
    gap_count: result.gaps.length,
    blocked_count: result.blocked.length,
    provenance_completeness: calculateCompleteness(result),
  };
}

function calculateCompleteness(result: ProvenanceFilterResult): number {
  if (result.governance_eligible.length === 0) return 0;
  const total = result.governance_eligible.length + result.context_only.length + result.inferred_only.length;
  return Math.round((total / result.governance_eligible.length) * 100);
}

function alwaysGovernance(): ProvenanceCompletenessCheck {
  return { eligibility: 'governance_eligible', missing_fields: [], gap_reason: '', is_governance_eligible: true };
}

function alwaysContext(): ProvenanceCompletenessCheck {
  return { eligibility: 'context_only', missing_fields: [], gap_reason: '', is_governance_eligible: false };
}

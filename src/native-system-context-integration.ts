import {
  NativeContextIntegration,
  NativeSystemContextSource,
} from './native-system-context.js';
import type {
  GovernanceEligibility,
  MemoryRecord,
  NativeContextSourceOutput,
  ProvenanceCompletenessCheck,
} from './native-system-context-types.js';

const GOVERNANCE_SOURCE_KINDS = new Set(['transcript', 'tool_trace', 'file_diff', 'user_supplied']);
const GOVERNANCE_EVIDENCE = new Set(['direct_original']);
const CONTEXT_EVIDENCE = new Set(['direct_summary']);

export class ProvenanceAwareContextGovernor {
  async recallContext(records: MemoryRecord[]): Promise<NativeContextSourceOutput> {
    return NativeSystemContextSource.generateContext(
      records,
      this.checkGovernanceCompleteness.bind(this),
    );
  }

  checkGovernanceCompleteness(record: MemoryRecord): ProvenanceCompletenessCheck {
    const missingFields = findMissingFields(record);
    const eligibility = determineGovernanceEligibility(record, missingFields);
    return {
      eligibility,
      missing_fields: missingFields,
      gap_reason: determineGapReason(record, eligibility, missingFields),
      is_governance_eligible: eligibility === 'governance_eligible',
    };
  }

  async generateGovernanceConstraints(records: MemoryRecord[]): Promise<string[]> {
    return NativeContextIntegration.generateGovernanceConstraints(
      records,
      this.checkGovernanceCompleteness.bind(this),
    );
  }

  async generateContextStatements(records: MemoryRecord[]): Promise<string[]> {
    return NativeContextIntegration.generateContextStatements(
      records,
      this.checkGovernanceCompleteness.bind(this),
    );
  }
}

export class ProvenanceAwareContextCompiler {
  static async compileContext(
    records: MemoryRecord[],
    governor?: ProvenanceAwareContextGovernor,
  ): Promise<NativeContextSourceOutput> {
    return (governor ?? new ProvenanceAwareContextGovernor()).recallContext(records);
  }
}

export class NativeContextIntegrationPoint {
  private provenanceGovernor = new ProvenanceAwareContextGovernor();

  async injectContext(records: MemoryRecord[]): Promise<NativeContextSourceOutput> {
    return this.provenanceGovernor.recallContext(records);
  }

  async getGovernanceConstraints(records: MemoryRecord[]): Promise<string[]> {
    return this.provenanceGovernor.generateGovernanceConstraints(records);
  }

  async getContextStatements(records: MemoryRecord[]): Promise<string[]> {
    return this.provenanceGovernor.generateContextStatements(records);
  }

  async checkRecordEligibility(records: MemoryRecord[]): Promise<Map<MemoryRecord, GovernanceEligibility>> {
    const eligibilityMap = new Map<MemoryRecord, GovernanceEligibility>();
    for (const record of records) {
      const check = this.provenanceGovernor.checkGovernanceCompleteness(record);
      eligibilityMap.set(record, check.eligibility);
    }
    return eligibilityMap;
  }
}

export const nativeContextIntegration = new NativeContextIntegrationPoint();

function determineGovernanceEligibility(
  record: MemoryRecord,
  missingFields: string[],
): GovernanceEligibility {
  if (missingFields.length >= 4) return 'gap_record';
  if (record.source_kind === 'summary' || record.derivative_of) return 'context_only';
  if (!record.source_kind || !GOVERNANCE_SOURCE_KINDS.has(record.source_kind)) return 'inferred_only';
  if (!record.evidence_strength) return 'inferred_only';
  if (CONTEXT_EVIDENCE.has(record.evidence_strength)) return 'context_only';
  if (!GOVERNANCE_EVIDENCE.has(record.evidence_strength)) return 'inferred_only';
  if (missingFields.length > 0) return 'context_only';
  return 'governance_eligible';
}

function findMissingFields(record: MemoryRecord): string[] {
  const missing: string[] = [];
  if (!record.source_kind) missing.push('source_kind');
  if (!record.evidence_strength) missing.push('evidence_strength');
  if (!record.source_session_id) missing.push('source_session_id');
  if (!record.source_agent_id) missing.push('source_agent_id');
  if (!record.source_model_id) missing.push('source_model_id');
  if (!record.source_surface) missing.push('source_surface');
  return missing;
}

function determineGapReason(
  record: MemoryRecord,
  eligibility: GovernanceEligibility,
  missingFields: string[],
): string {
  if (eligibility === 'gap_record') return `Missing provenance: ${missingFields.join(', ')}`;
  if (eligibility === 'inferred_only') return 'Heuristic-based inference - not authoritative';
  if (eligibility !== 'context_only') return 'Gap in provenance information';
  if (record.evidence_strength === 'direct_summary') return 'Direct summary - context only';
  if (record.source_kind !== 'summary' && !record.derivative_of) {
    return 'Partial provenance - context only';
  }
  return 'Summary record - context only';
}

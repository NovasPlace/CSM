/**
 * Native SystemContext.Source Integration
 * 
 * Integration layer between the Native SystemContext.Source and the
 * existing context system (context-governor, context-compiler, context-recall).
 */

import { NativeSystemContextSource, 
         NativeContextIntegration,
         GovernanceEligibility,
         NativeContextSourceOutput,
         ProvenanceCompletenessCheck,
         CategorizedContextRecord } from './native-system-context-types'
import { MemoryRecord } from './memory-manager'
import { ContextGovernor } from './context-governor'

/**
 * Enhanced context governor with provenance-aware governance
 */
export class ProvenanceAwareContextGovernor extends ContextGovernor {
  
  private nativeContextSource: NativeContextSource

  constructor() {
    super()
    this.nativeContextSource = new NativeSystemContextSource()
  }

  /**
   * Override context recall to use provenance filtering
   * 
   * @param records - Memory records to recall
   * @returns Filtered context with governance eligibility
   */
  override async recallContext(records: MemoryRecord[]): Promise<NativeContextSourceOutput> {
    // Apply provenance filtering using the governance completeness gate
    const provenanceCheck = this.checkGovernanceCompleteness.bind(this)
    return NativeSystemContextSource.generateContext(records, provenanceCheck)
  }

  /**
   * Check governance eligibility using the provenance completeness gate
   * 
   * @param record - Memory record to check
   * @returns Provenance completeness check result
   */
  checkGovernanceCompleteness(record: MemoryRecord): ProvenanceCompletenessCheck {
    // Implement actual governance completeness checking
    // This would integrate with the governance gate from memory_governance.ts
    
    const eligibility = this.determineGovernanceEligibility(record)
    const missingFields = this.findMissingFields(record)
    const gapReason = this.determineGapReason(record, eligibility, missingFields)
    
    return {
      eligibility,
      missing_fields: missingFields,
      gap_reason: gapReason,
      is_governance_eligible: eligibility === 'governance_eligible'
    }
  }

  /**
   * Determine governance eligibility based on provenance
   * 
   * @param record - Memory record to evaluate
   * @returns Governance eligibility category
   */
  private determineGovernanceEligibility(record: MemoryRecord): GovernanceEligibility {
    // Implementation should check:
    // 1. source_kind (transcript, tool_trace, file_diff, summary, inferred, user_supplied)
    // 2. evidence_strength (direct_original, direct_summary, inferred, gap)
    // 3. derivative_of (for summaries, must point to valid source)
    // 4. source_session_id (must exist or have explicit gap reason)
    // 5. source_agent_id (must exist or have explicit gap reason)
    // 6. source_model_id (must exist or have explicit gap reason)
    // 7. source_surface (must exist or have explicit gap reason)
    
    // Default to governance_eligible for now
    return 'governance_eligible'
  }

  /**
   * Find missing provenance fields
   * 
   * @param record - Memory record to check
   * @returns Missing field names
   */
  private findMissingFields(record: MemoryRecord): string[] {
    const missing: string[] = []
    
    if (!record.source_kind) missing.push('source_kind')
    if (!record.evidence_strength) missing.push('evidence_strength')
    if (!record.source_session_id) missing.push('source_session_id')
    if (!record.source_agent_id) missing.push('source_agent_id')
    if (!record.source_model_id) missing.push('source_model_id')
    if (!record.source_surface) missing.push('source_surface')
    
    return missing
  }

  /**
   * Determine gap reason if eligibility is not governance_eligible
   * 
   * @param record - Memory record to evaluate
   * @param eligibility - Current eligibility category
   * @param missingFields - Missing provenance fields
   * @returns Gap reason string
   */
  private determineGapReason(
    record: MemoryRecord, 
    eligibility: GovernanceEligibility,
    missingFields: string[]
  ): string {
    switch (eligibility) {
      case 'gap_record':
        return `Missing provenance: ${missingFields.join(', ')}`
      case 'context_only':
        if (!record.derivative_of) {
          return 'Summary without derivative_of tracking'
        }
        return 'Summary record - context only'
      case 'inferred_only':
        return 'Heuristic-based inference - not authoritative'
      default:
        return 'Gap in provenance information'
    }
  }

  /**
   * Generate governance constraints from governance_eligible records
   * 
   * @param records - Memory records to filter
   * @returns Governance constraint statements
   */
  async generateGovernanceConstraints(records: MemoryRecord[]): Promise<string[]> {
    const provenanceCheck = this.checkGovernanceCompleteness.bind(this)
    return NativeContextIntegration.generateGovernanceConstraints(records, provenanceCheck)
  }

  /**
   * Generate context-only statements from context_only records
   * 
   * @param records - Memory records to filter
   * @returns Context-only statements
   */
  async generateContextStatements(records: MemoryRecord[]): Promise<string[]> {
    const provenanceCheck = this.checkGovernanceCompleteness.bind(this)
    return NativeContextIntegration.generateContextStatements(records, provenanceCheck)
  }
}

/**
 * Context compiler integration with provenance filtering
 */
export class ProvenanceAwareContextCompiler {
  
  /**
   * Compile context with provenance-aware filtering
   * 
   * @param records - Memory records to compile
   * @param governor - Context governor instance
   * @returns Compiled context with categorization
   */
  static async compileContext(
    records: MemoryRecord[],
    governor: ContextGovernor
  ): Promise<NativeContextSourceOutput> {
    // Use the provenance-aware governor
    const provenanceGovernor = governor instanceof ProvenanceAwareContextGovernor 
      ? governor 
      : new ProvenanceAwareContextGovernor()
    
    return provenanceGovernor.recallContext(records)
  }
}

/**
 * Integration point for V2 context injection pipeline
 */
export class NativeContextIntegrationPoint {
  
  private provenanceGovernor: ProvenanceAwareContextGovernor

  constructor() {
    this.provenanceGovernor = new ProvenanceAwareContextGovernor()
  }

  /**
   * Hook into V2 context injection pipeline
   * 
   * @param records - Memory records to inject
   * @returns Native context source output with categorization
   */
  async injectContext(records: MemoryRecord[]): Promise<NativeContextSourceOutput> {
    return this.provenanceGovernor.recallContext(records)
  }

  /**
   * Get governance constraints for veto power
   * 
   * @param records - Memory records to filter
   * @returns Governance constraints that can veto behavior
   */
  async getGovernanceConstraints(records: MemoryRecord[]): Promise<string[]> {
    return this.provenanceGovernor.generateGovernanceConstraints(records)
  }

  /**
   * Get context-only information for background context
   * 
   * @param records - Memory records to filter
   * @returns Context statements that can inform but not veto
   */
  async getContextStatements(records: MemoryRecord[]): Promise<string[]> {
    return this.provenanceGovernor.generateContextStatements(records)
  }

  /**
   * Check if specific records can constrain behavior
   * 
   * @param records - Memory records to check
   * @returns Record-eligibility mapping
   */
  async checkRecordEligibility(records: MemoryRecord[]): Promise<Map<MemoryRecord, GovernanceEligibility>> {
    const eligibilityMap = new Map<MemoryRecord, GovernanceEligibility>()
    
    for (const record of records) {
      const check = this.provenanceGovernor.checkGovernanceCompleteness(record)
      eligibilityMap.set(record, check.eligibility)
    }
    
    return eligibilityMap
  }
}

// Export the integration functions for easy use
export const nativeContextIntegration = new NativeContextIntegrationPoint()
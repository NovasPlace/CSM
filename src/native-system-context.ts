/**
 * Native SystemContext.Source - Provenance-Aware Context Generation for V2
 * 
 * This module provides a provenance-aware context source that integrates
 * with the native V2 runtime, using the provenance completeness gate to
 * filter records before injection.
 * 
 * Core Principles:
 * - Only direct_original evidence can constrain behavior (governance_eligible)
 * - Direct_summary records can provide context but not veto power
 * - Inferred signals are informative only
 * - Missing provenance records are flagged for audit
 * - Synthetics and summaries without provenance are blocked from governance
 */

import { MemoryRecord, MemoryContextResult } from './memory-manager';

/**
 * Governance eligibility categories
 */
export type GovernanceEligibility = 
  | 'governance_eligible'  // Can veto behavior
  | 'context_only'        // Can provide context, not veto
  | 'inferred_only'       // Heuristic signals, not authoritative
  | 'gap_record'          // Missing provenance, audit only

/**
 * Context record with categorization
 */
export interface CategorizedContextRecord {
  record: MemoryRecord
  eligibility: GovernanceEligibility
  source_kind: string
  evidence_strength: string
  derivative_of?: string
  gap_reason?: string
}

/**
 * Provenance filter result
 */
export interface ProvenanceFilterResult {
  governance_eligible: CategorizedContextRecord[]
  context_only: CategorizedContextRecord[]
  inferred_only: CategorizedContextRecord[]
  gaps: CategorizedContextRecord[]
  blocked: CategorizedContextRecord[]
}

/**
 * Native context source output structure
 */
export interface NativeContextSourceOutput {
  governance_eligible_section: string
  governance_records: CategorizedContextRecord[]
  context_only_section: string
  context_records: CategorizedContextRecord[]
  inferred_section: string
  inferred_records: CategorizedContextRecord[]
  gaps_section: string
  gap_records: CategorizedContextRecord[]
  blocked_section: string
  blocked_records: CategorizedContextRecord[]
  metadata: {
    total_records: number
    governance_eligible_count: number
    context_only_count: number
    inferred_count: number
    gap_count: number
    blocked_count: number
    provenance_completeness: number
  }
}

/**
 * Provenance completeness gate result
 */
export interface ProvenanceCompletenessCheck {
  eligibility: GovernanceEligibility
  missing_fields: string[]
  gap_reason: string
  is_governance_eligible: boolean
}

/**
 * Native SystemContext.Source class
 * 
 * Provides provenance-aware context generation that respects the
 * completeness gate and categorizes records appropriately.
 */
export class NativeSystemContextSource {
  /**
   * Apply provenance filtering to memory records
   * 
   * @param records - Memory records to filter
   * @param checkGovernanceCompleteness - Function to check governance eligibility
   * @returns Categorized context records
   */
  static applyProvenanceFilter(
    records: MemoryRecord[],
    checkGovernanceCompleteness: (record: MemoryRecord) => ProvenanceCompletenessCheck
  ): ProvenanceFilterResult {
    const governance_eligible: CategorizedContextRecord[] = []
    const context_only: CategorizedContextRecord[] = []
    const inferred_only: CategorizedContextRecord[] = []
    const gaps: CategorizedContextRecord[] = []
    const blocked: CategorizedContextRecord[] = []

    for (const record of records) {
      const check = checkGovernanceCompleteness(record)
      
      const categorized: CategorizedContextRecord = {
        record: record,
        eligibility: check.eligibility,
        source_kind: record.source_kind || 'unknown',
        evidence_strength: record.evidence_strength || 'gap',
        derivative_of: record.derivative_of,
        gap_reason: check.gap_reason
      }

      switch (check.eligibility) {
        case 'governance_eligible':
          governance_eligible.push(categorized)
          break
        case 'context_only':
          context_only.push(categorized)
          break
        case 'inferred_only':
          inferred_only.push(categorized)
          break
        case 'gap_record':
          gaps.push(categorized)
          break
      }

      if (check.eligibility === 'gap_record') {
        blocked.push(categorized)
      }
    }

    return {
      governance_eligible,
      context_only,
      inferred_only,
      gaps,
      blocked
    }
  }

  /**
   * Generate native context output from memory recall results
   * 
   * @param records - Memory records to generate context from
   * @param checkGovernanceCompleteness - Function to check governance eligibility
   * @returns Structured context output with categorization
   */
  static generateContext(
    records: MemoryRecord[],
    checkGovernanceCompleteness: (record: MemoryRecord) => ProvenanceCompletenessCheck
  ): NativeContextSourceOutput {
    const filterResult = this.applyProvenanceFilter(records, checkGovernanceCompleteness)

    const metadata = {
      total_records: records.length,
      governance_eligible_count: filterResult.governance_eligible.length,
      context_only_count: filterResult.context_only.length,
      inferred_count: filterResult.inferred_only.length,
      gap_count: filterResult.gaps.length,
      blocked_count: filterResult.blocked.length,
      provenance_completeness: this.calculateCompleteness(filterResult)
    }

    return {
      governance_eligible_section: "The following records can constrain future behavior (governance_eligible):",
      governance_records: filterResult.governance_eligible,
      context_only_section: "The following records provide context but cannot constrain (context_only):",
      context_records: filterResult.context_only,
      inferred_section: "Inferred signals from patterns (inferred):",
      inferred_records: filterResult.inferred_only,
      gaps_section: "Missing provenance (for audit/improvement):",
      gap_records: filterResult.gaps,
      blocked_section: "Blocked governance records (cannot veto):",
      blocked_records: filterResult.blocked,
      metadata
    }
  }

  /**
   * Calculate provenance completeness percentage
   * 
   * @param filterResult - Categorized filter result
   * @returns Completeness score (0-100)
   */
  private static calculateCompleteness(filterResult: ProvenanceFilterResult): number {
    if (filterResult.governance_eligible.length === 0) return 0
    
    const total_with_provenance = 
      filterResult.governance_eligible.length + 
      filterResult.context_only.length + 
      filterResult.inferred_only.length
    
    return Math.round((total_with_provenance / filterResult.governance_eligible.length) * 100)
  }

  /**
   * Create governance constraint from governance_eligible record
   * 
   * @param record - Governance eligible record
   * @returns Governance constraint statement
   */
  static createGovernanceConstraint(record: CategorizedContextRecord): string {
    return `Governance constraint from ${record.source_kind}: ${record.record.content?.substring(0, 100)}...`
  }

  /**
   * Create context only statement from context_only record
   * 
   * @param record - Context only record
   * @returns Context statement
   */
  static createContextStatement(record: CategorizedContextRecord): string {
    return `Context from ${record.source_kind}: ${record.record.content?.substring(0, 100)}...`
  }

  /**
   * Create gap statement from missing provenance record
   * 
   * @param record - Gap record
   * @returns Gap statement
   */
  static createGapStatement(record: CategorizedContextRecord): string {
    return `Gap: ${record.gap_reason || 'Missing provenance information'}`
  }

  /**
   * Create blocked governance statement from blocked record
   * 
   * @param record - Blocked record
   * @returns Blocked statement
   */
  static createBlockedStatement(record: CategorizedContextRecord): string {
    return `Blocked: ${record.source_kind} without sufficient provenance`
  }
}

/**
 * Integration helper functions for native context source
 */

export interface NativeContextIntegration {
  useNativeSystemContext(
    records: MemoryRecord[],
    checkGovernanceCompleteness: (record: MemoryRecord) => ProvenanceCompletenessCheck
  ): NativeContextSourceOutput
  
  filterForGovernance(records: MemoryRecord[]): CategorizedContextRecord[]
  
  filterForContext(records: MemoryRecord[]): CategorizedContextRecord[]
  
  generateGovernanceConstraints(
    records: MemoryRecord[],
    checkGovernanceCompleteness: (record: MemoryRecord) => ProvenanceCompletenessCheck
  ): string[]
  
  generateContextStatements(
    records: MemoryRecord[],
    checkGovernanceCompleteness: (record: MemoryRecord) => ProvenanceCompletenessCheck
  ): string[]
}

export const NativeContextIntegration: NativeContextIntegration = {
  useNativeSystemContext(records, checkGovernanceCompleteness) {
    return NativeSystemContextSource.generateContext(records, checkGovernanceCompleteness)
  },

  filterForGovernance(records: MemoryRecord[]): CategorizedContextRecord[] {
    const check: any = (record: MemoryRecord) => {
      return {
        eligibility: 'governance_eligible' as GovernanceEligibility,
        missing_fields: [] as string[],
        gap_reason: '' as string,
        is_governance_eligible: true
      }
    }
    return NativeSystemContextSource.applyProvenanceFilter(records, check).governance_eligible
  },

  filterForContext(records: MemoryRecord[]): CategorizedContextRecord[] {
    const check: any = (record: MemoryRecord) => {
      return {
        eligibility: 'context_only' as GovernanceEligibility,
        missing_fields: [] as string[],
        gap_reason: '' as string,
        is_governance_eligible: false
      }
    }
    return NativeSystemContextSource.applyProvenanceFilter(records, check).context_only
  },

  generateGovernanceConstraints(
    records: MemoryRecord[],
    checkGovernanceCompleteness: (record: MemoryRecord) => ProvenanceCompletenessCheck
  ): string[] {
    const governanceRecords = NativeSystemContextSource.applyProvenanceFilter(
      records, 
      checkGovernanceCompleteness
    ).governance_eligible
    
    return governanceRecords.map(record => 
      NativeSystemContextSource.createGovernanceConstraint(record)
    )
  },

  generateContextStatements(
    records: MemoryRecord[],
    checkGovernanceCompleteness: (record: MemoryRecord) => ProvenanceCompletenessCheck
  ): string[] {
    const contextRecords = NativeSystemContextSource.applyProvenanceFilter(
      records, 
      checkGovernanceCompleteness
    ).context_only
    
    return contextRecords.map(record => 
      NativeSystemContextSource.createContextStatement(record)
    )
  }
}
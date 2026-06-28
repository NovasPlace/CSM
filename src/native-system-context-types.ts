/**
 * Native SystemContext.Source Type Definitions
 * 
 * TypeScript definitions for the provenance-aware context generation system
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
 * Native SystemContext.Source class definition
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
  ): ProvenanceFilterResult

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
  ): NativeContextSourceOutput

  /**
   * Calculate provenance completeness percentage
   * 
   * @param filterResult - Categorized filter result
   * @returns Completeness score (0-100)
   */
  private static calculateCompleteness(filterResult: ProvenanceFilterResult): number

  /**
   * Create governance constraint from governance_eligible record
   * 
   * @param record - Governance eligible record
   * @returns Governance constraint statement
   */
  static createGovernanceConstraint(record: CategorizedContextRecord): string

  /**
   * Create context only statement from context_only record
   * 
   * @param record - Context only record
   * @returns Context statement
   */
  static createContextStatement(record: CategorizedContextRecord): string

  /**
   * Create gap statement from missing provenance record
   * 
   * @param record - Gap record
   * @returns Gap statement
   */
  static createGapStatement(record: CategorizedContextRecord): string

  /**
   * Create blocked governance statement from blocked record
   * 
   * @param record - Blocked record
   * @returns Blocked statement
   */
  static createBlockedStatement(record: CategorizedContextRecord): string
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
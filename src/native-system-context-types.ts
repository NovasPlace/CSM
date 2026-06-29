/**
 * Native SystemContext.Source Type Definitions
 * 
 * TypeScript definitions for the provenance-aware context generation system
 */

import type { Memory } from './types.js';

export type MemoryRecord = Partial<Memory> & {
  source_kind?: string
  evidence_strength?: string
  source_session_id?: string
  source_agent_id?: string
  source_model_id?: string
  source_surface?: string
  derivative_of?: string
  session_id?: string
  memory_type?: string
  created_at?: string
  [key: string]: unknown
}

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

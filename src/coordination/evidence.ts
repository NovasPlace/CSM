import {
  requireArray,
  requireEnum,
  requireNullableString,
  requireRecord,
  requireString,
} from './schema-validation.js';
import type {
  Deliverable,
  EvidenceReference,
  Finding,
  RiskRecord,
} from './types.js';

const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;

export function validateEvidenceReference(value: unknown): EvidenceReference {
  const row = requireRecord(value, 'evidence reference');
  const result = {
    kind: requireString(row, 'kind'),
    reference: requireString(row, 'reference'),
    sha256: requireNullableString(row, 'sha256'),
  };
  if (result.sha256 !== null && !/^[a-f0-9]{64}$/.test(result.sha256)) {
    throw new TypeError('sha256 must be null or a lowercase SHA-256 digest');
  }
  return result;
}

export function validateFinding(value: unknown): Finding {
  const row = requireRecord(value, 'finding');
  return {
    id: requireString(row, 'id'),
    severity: requireEnum(row, 'severity', RISK_LEVELS),
    summary: requireString(row, 'summary'),
    evidence: requireArray(row, 'evidence').map(validateEvidenceReference),
  };
}

export function validateDeliverable(value: unknown): Deliverable {
  const row = requireRecord(value, 'deliverable');
  return {
    contractId: requireString(row, 'contractId'),
    reference: requireString(row, 'reference'),
    summary: requireString(row, 'summary'),
  };
}

export function validateRisk(value: unknown): RiskRecord {
  const row = requireRecord(value, 'risk record');
  return {
    severity: requireEnum(row, 'severity', RISK_LEVELS),
    description: requireString(row, 'description'),
  };
}

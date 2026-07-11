import { CoordinationDomainError } from './errors.js';
import { validateEvidenceReference } from './evidence.js';
import {
  requireArray,
  requireEnum,
  requireNullableTimestamp,
  requireRecord,
  requireString,
} from './schema-validation.js';
import type { CoordinationAssignment, VerificationResult } from './types.js';

const VERIFICATION_STATUSES = ['pending', 'passed', 'failed', 'waived'] as const;

export function validateVerificationResult(value: unknown): VerificationResult {
  const row = requireRecord(value, 'verification result');
  const result: VerificationResult = {
    id: requireString(row, 'id'), criterionId: requireString(row, 'criterionId'),
    status: requireEnum(row, 'status', VERIFICATION_STATUSES),
    evidence: requireArray(row, 'evidence').map(validateEvidenceReference),
    verifiedAt: requireNullableTimestamp(row, 'verifiedAt'),
  };
  if (result.status === 'passed' && !isEvidencedPass(result)) {
    throw new CoordinationDomainError('VERIFICATION_REQUIRED', 'Passed verification requires evidence and a timestamp');
  }
  return result;
}

export function assertVerificationComplete(
  assignment: CoordinationAssignment,
  results: readonly VerificationResult[],
): void {
  if (!assignment.requiresVerification) return;
  const required = assignment.completionCriteria.filter((criterion) => criterion.required);
  if (required.length === 0) {
    throw new CoordinationDomainError('VERIFICATION_REQUIRED', 'No required verification criteria are defined');
  }
  const passed = new Set(results
    .filter(isEvidencedPass)
    .map((result) => result.criterionId));
  const missing = required.filter((criterion) => !passed.has(criterion.id));
  if (missing.length > 0) {
    throw new CoordinationDomainError('VERIFICATION_REQUIRED', 'Required verification is incomplete', {
      missingCriteria: missing.map((criterion) => criterion.id),
    });
  }
}

function isEvidencedPass(result: VerificationResult): boolean {
  if (result.status !== 'passed'
    || typeof result.verifiedAt !== 'string'
    || !Number.isFinite(Date.parse(result.verifiedAt))
    || !Array.isArray(result.evidence)
    || result.evidence.length === 0) return false;
  try {
    result.evidence.forEach(validateEvidenceReference);
    return true;
  } catch {
    return false;
  }
}

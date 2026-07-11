import { CoordinationDomainError } from './errors.js';
import {
  validateDeliverable,
  validateEvidenceReference,
  validateFinding,
  validateRisk,
} from './evidence.js';
import {
  requireArray,
  requireRecord,
  requireString,
  requireStringArray,
  requireTimestamp,
} from './schema-validation.js';
import type { CoordinationAssignment, HandoffPacket } from './types.js';
import { assertVerificationComplete, validateVerificationResult } from './verification-service.js';

export function validateHandoffPacket(value: unknown): HandoffPacket {
  const row = requireRecord(value, 'handoff packet');
  const fromAgentId = requireString(row, 'fromAgentId');
  const toAgentId = requireString(row, 'toAgentId');
  if (fromAgentId === toAgentId) throw new TypeError('Handoff agents must be different');
  return {
    id: requireString(row, 'id'), assignmentId: requireString(row, 'assignmentId'),
    fromAgentId, toAgentId, summary: requireString(row, 'summary'),
    findings: requireArray(row, 'findings').map(validateFinding),
    deliverables: requireArray(row, 'deliverables').map(validateDeliverable),
    changedResources: requireStringArray(row, 'changedResources'),
    unresolvedQuestions: requireStringArray(row, 'unresolvedQuestions'),
    risks: requireArray(row, 'risks').map(validateRisk),
    evidence: requireArray(row, 'evidence').map(validateEvidenceReference),
    verificationResults: requireArray(row, 'verificationResults').map(validateVerificationResult),
    createdAt: requireTimestamp(row, 'createdAt'),
  };
}

export function assertHandoffComplete(
  assignment: CoordinationAssignment,
  handoff: HandoffPacket,
): void {
  if (handoff.assignmentId !== assignment.id
    || (assignment.assignedAgentId && handoff.fromAgentId !== assignment.assignedAgentId)) {
    throw new CoordinationDomainError('HANDOFF_INCOMPLETE', 'Handoff does not match its assignment');
  }
  assertRequiredDeliverables(assignment, handoff);
  assertChangedResourcesAllowed(assignment, handoff);
  assertVerificationComplete(assignment, handoff.verificationResults);
}

function assertRequiredDeliverables(
  assignment: CoordinationAssignment,
  handoff: HandoffPacket,
): void {
  const submitted = new Set(handoff.deliverables.map((deliverable) => deliverable.contractId));
  const missing = assignment.requiredDeliverables
    .filter((contract) => contract.required && !submitted.has(contract.id));
  if (missing.length > 0) {
    throw new CoordinationDomainError('HANDOFF_INCOMPLETE', 'Required handoff deliverables are missing', {
      missingDeliverables: missing.map((contract) => contract.id),
    });
  }
}

function assertChangedResourcesAllowed(
  assignment: CoordinationAssignment,
  handoff: HandoffPacket,
): void {
  const allowed = new Set(assignment.allowedResources.map((scope) => scope.resourceId));
  const outside = handoff.changedResources.filter((resource) => !allowed.has(resource));
  if (outside.length > 0) {
    throw new CoordinationDomainError('ASSIGNMENT_SCOPE_VIOLATION', 'Handoff includes resources outside assignment scope', {
      resources: outside,
    });
  }
}

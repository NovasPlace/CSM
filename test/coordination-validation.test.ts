import { it } from 'node:test';
import assert from 'node:assert/strict';
import { COORDINATION_ERROR_CODES, CoordinationDomainError } from '../src/coordination/errors.js';
import {
  validateDeliverable,
  validateEvidenceReference,
  validateFinding,
  validateRisk,
} from '../src/coordination/evidence.js';
import { validateCoordinationEvent } from '../src/coordination/event-service.js';
import {
  validateAgent,
  validateAssignment,
  validateClaim,
  validateDependency,
  validatePrimaryAgentRoster,
  validateResourceScope,
  validateWorkspace,
} from '../src/coordination/validators.js';
import {
  agent,
  assignment,
  claim,
  dependency,
  event,
  evidence,
  scope,
  workspace,
} from './coordination-fixtures.js';

it('locks the required stable error codes', () => {
  assert.deepEqual(COORDINATION_ERROR_CODES, [
    'WORKSPACE_NOT_FOUND', 'PRIMARY_AGENT_REQUIRED', 'INVALID_STATE_TRANSITION',
    'ASSIGNMENT_DEPENDENCY_UNRESOLVED', 'ASSIGNMENT_SCOPE_VIOLATION',
    'RESOURCE_ALREADY_CLAIMED', 'RESOURCE_CLAIM_EXPIRED', 'APPROVAL_REQUIRED',
    'APPROVAL_EXPIRED', 'VERSION_CONFLICT', 'HANDOFF_INCOMPLETE',
    'VERIFICATION_REQUIRED', 'FEATURE_DISABLED',
  ]);
});

it('validates a workspace round trip', () => {
  const value = workspace();
  assert.deepEqual(validateWorkspace(roundTrip(value)), value);
});

it('rejects a non-object workspace', () => {
  assert.throws(() => validateWorkspace(null), TypeError);
});

it('rejects a workspace without a primary agent', () => {
  assertCode(() => validateWorkspace({ ...workspace(), primaryAgentId: '' }), 'PRIMARY_AGENT_REQUIRED');
});

it('rejects an invalid workspace status', () => {
  assert.throws(() => validateWorkspace({ ...workspace(), status: 'running' }), TypeError);
});

it('rejects a zero workspace version', () => {
  assert.throws(() => validateWorkspace({ ...workspace(), version: 0 }), TypeError);
});

it('rejects a malformed workspace timestamp', () => {
  assert.throws(() => validateWorkspace({ ...workspace(), updatedAt: 'yesterday' }), TypeError);
});

it('validates an agent round trip', () => {
  const value = agent();
  assert.deepEqual(validateAgent(roundTrip(value)), value);
});

it('rejects an invalid agent role', () => {
  assert.throws(() => validateAgent({ ...agent(), role: 'owner' }), TypeError);
});

it('rejects non-string capabilities', () => {
  assert.throws(() => validateAgent({ ...agent(), capabilities: [7] }), TypeError);
});

it('accepts exactly one matching primary agent', () => {
  assert.doesNotThrow(() => validatePrimaryAgentRoster(workspace(), [agent()]));
});

it('rejects a missing primary agent', () => {
  assertCode(() => validatePrimaryAgentRoster(workspace(), []), 'PRIMARY_AGENT_REQUIRED');
});

it('rejects duplicate primary agents', () => {
  assertCode(() => validatePrimaryAgentRoster(workspace(), [agent(), agent({ id: 'other' })]), 'PRIMARY_AGENT_REQUIRED');
});

it('rejects a primary-agent identity mismatch', () => {
  assertCode(() => validatePrimaryAgentRoster(workspace(), [agent({ id: 'other' })]), 'PRIMARY_AGENT_REQUIRED');
});

it('validates an assignment round trip', () => {
  const value = assignment();
  assert.deepEqual(validateAssignment(roundTrip(value)), value);
});

it('rejects a malformed assignment priority', () => {
  assert.throws(() => validateAssignment({ ...assignment(), priority: -1 }), TypeError);
});

it('rejects malformed assignment resources', () => {
  assert.throws(() => validateAssignment({ ...assignment(), allowedResources: ['src'] }), TypeError);
});

it('rejects a self-parenting assignment', () => {
  assertCode(
    () => validateAssignment({ ...assignment(), parentAssignmentId: 'assignment-1' }),
    'ASSIGNMENT_DEPENDENCY_UNRESOLVED',
  );
});

it('rejects an active assignment without an agent', () => {
  const value = { ...assignment(), status: 'active', assignedAgentId: null };
  assertCode(() => validateAssignment(value), 'INVALID_STATE_TRANSITION');
});

it('validates a full-file resource scope', () => {
  assert.deepEqual(validateResourceScope(scope()), scope());
});

it('requires a region for file-region scope', () => {
  const value = scope({ resourceType: 'file_region', region: null });
  assertCode(() => validateResourceScope(value), 'ASSIGNMENT_SCOPE_VIOLATION');
});

it('rejects reversed file regions', () => {
  const value = scope({ resourceType: 'file_region', region: { startLine: 20, endLine: 10 } });
  assert.throws(() => validateResourceScope(value), TypeError);
});

it('rejects zero line numbers', () => {
  const value = scope({ resourceType: 'file_region', region: { startLine: 0, endLine: 10 } });
  assert.throws(() => validateResourceScope(value), TypeError);
});

it('validates a dependency', () => {
  assert.deepEqual(validateDependency(dependency()), dependency());
});

it('rejects a self-dependency', () => {
  const value = dependency({ assignmentId: 'same', dependsOnAssignmentId: 'same' });
  assertCode(() => validateDependency(value), 'ASSIGNMENT_DEPENDENCY_UNRESOLVED');
});

it('validates a resource claim', () => {
  assert.deepEqual(validateClaim(claim()), claim());
});

it('rejects an invalid claim status', () => {
  assert.throws(() => validateClaim({ ...claim(), status: 'abandoned' }), TypeError);
});

it('validates evidence, findings, deliverables, and risks', () => {
  assert.deepEqual(validateEvidenceReference(evidence()), evidence());
  assert.equal(validateFinding({ id: 'f1', severity: 'high', summary: 'Finding', evidence: [] }).id, 'f1');
  assert.equal(validateDeliverable({ contractId: 'code', reference: 'src/a.ts', summary: 'Code' }).contractId, 'code');
  assert.equal(validateRisk({ severity: 'low', description: 'Residual risk' }).severity, 'low');
});

it('rejects malformed evidence arrays', () => {
  assert.throws(() => validateFinding({ id: 'f1', severity: 'high', summary: 'Finding', evidence: {} }), TypeError);
});

it('rejects malformed evidence hashes', () => {
  assert.throws(() => validateEvidenceReference(evidence({ sha256: 'not-a-hash' })), TypeError);
});

it('validates an event round trip', () => {
  const value = event();
  assert.deepEqual(validateCoordinationEvent(roundTrip(value)), value);
});

it('rejects an array event payload', () => {
  assert.throws(() => validateCoordinationEvent({ ...event(), payload: [] }), TypeError);
});

it('rejects a zero event sequence', () => {
  assert.throws(() => validateCoordinationEvent({ ...event(), sequence: 0 }), TypeError);
});

function roundTrip<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

function assertCode(action: () => unknown, code: string): void {
  assert.throws(action, (error) => error instanceof CoordinationDomainError && error.code === code);
}

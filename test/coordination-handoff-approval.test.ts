import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertApprovalGranted,
  assertApprovalPending,
  isApprovalExpired,
  validateApprovalRequest,
} from '../src/coordination/approval-service.js';
import { CoordinationDomainError } from '../src/coordination/errors.js';
import { assertHandoffComplete, validateHandoffPacket } from '../src/coordination/handoff-service.js';
import {
  assertVerificationComplete,
  validateVerificationResult,
} from '../src/coordination/verification-service.js';
import {
  approval,
  assignment,
  handoff,
  NOW,
  verification,
} from './coordination-fixtures.js';

it('validates an approval request round trip', () => {
  const value = approval();
  assert.deepEqual(validateApprovalRequest(roundTrip(value)), value);
});

it('rejects low-risk approval requests', () => {
  assert.throws(() => validateApprovalRequest({ ...approval(), risk: 'low' }), TypeError);
});

it('rejects an invalid approval status', () => {
  assert.throws(() => validateApprovalRequest({ ...approval(), status: 'done' }), TypeError);
});

it('detects approval expiry at the exact boundary', () => {
  assert.equal(isApprovalExpired(approval({ expiresAt: NOW }), NOW), true);
});

it('keeps a future approval active', () => {
  assert.equal(isApprovalExpired(approval(), NOW), false);
});

it('treats explicit expired status as expired', () => {
  assert.equal(isApprovalExpired(approval({ status: 'expired', expiresAt: null }), NOW), true);
});

it('accepts a pending unexpired request', () => {
  assert.doesNotThrow(() => assertApprovalPending(approval(), NOW));
});

it('rejects an expired pending request', () => {
  const value = approval({ expiresAt: NOW });
  assertCode(() => assertApprovalPending(value, NOW), 'APPROVAL_EXPIRED');
});

it('rejects a non-pending request as pending', () => {
  assertCode(() => assertApprovalPending(approval({ status: 'approved' }), NOW), 'APPROVAL_REQUIRED');
});

it('accepts a granted unexpired approval', () => {
  assert.doesNotThrow(() => assertApprovalGranted(approval({ status: 'approved' }), NOW));
});

it('rejects a denied approval', () => {
  assertCode(() => assertApprovalGranted(approval({ status: 'rejected' }), NOW), 'APPROVAL_REQUIRED');
});

it('rejects an expired granted approval', () => {
  const value = approval({ status: 'approved', expiresAt: NOW });
  assertCode(() => assertApprovalGranted(value, NOW), 'APPROVAL_EXPIRED');
});

it('validates a verification result round trip', () => {
  const value = verification();
  assert.deepEqual(validateVerificationResult(roundTrip(value)), value);
});

it('rejects an invalid verification status', () => {
  assert.throws(() => validateVerificationResult({ ...verification(), status: 'ok' }), TypeError);
});

it('accepts complete required verification', () => {
  assert.doesNotThrow(() => assertVerificationComplete(assignment(), [verification()]));
});

it('rejects missing required verification', () => {
  assertCode(() => assertVerificationComplete(assignment(), []), 'VERIFICATION_REQUIRED');
});

it('rejects failed required verification', () => {
  const failed = verification({ status: 'failed' });
  assertCode(() => assertVerificationComplete(assignment(), [failed]), 'VERIFICATION_REQUIRED');
});

it('skips verification when the assignment does not require it', () => {
  assert.doesNotThrow(() => assertVerificationComplete(assignment({ requiresVerification: false }), []));
});

it('validates a handoff round trip', () => {
  const value = handoff();
  assert.deepEqual(validateHandoffPacket(roundTrip(value)), value);
});

it('rejects a handoff to the sending agent', () => {
  assert.throws(() => validateHandoffPacket({ ...handoff(), toAgentId: 'agent-worker' }), TypeError);
});

it('rejects malformed handoff collections', () => {
  assert.throws(() => validateHandoffPacket({ ...handoff(), findings: {} }), TypeError);
});

it('accepts a complete handoff', () => {
  assert.doesNotThrow(() => assertHandoffComplete(assignment(), handoff()));
});

it('rejects a handoff for another assignment', () => {
  assertCode(() => assertHandoffComplete(assignment(), handoff({ assignmentId: 'other' })), 'HANDOFF_INCOMPLETE');
});

it('rejects a handoff from an unassigned agent', () => {
  assertCode(() => assertHandoffComplete(assignment(), handoff({ fromAgentId: 'other' })), 'HANDOFF_INCOMPLETE');
});

it('rejects a missing required deliverable', () => {
  assertCode(() => assertHandoffComplete(assignment(), handoff({ deliverables: [] })), 'HANDOFF_INCOMPLETE');
});

it('allows a missing optional deliverable', () => {
  const value = assignment({
    requiredDeliverables: [{ id: 'optional', description: 'Optional', required: false }],
    requiresVerification: false,
  });
  assert.doesNotThrow(() => assertHandoffComplete(value, handoff({ deliverables: [] })));
});

it('rejects changed resources outside assignment scope', () => {
  const value = handoff({ changedResources: ['src/outside.ts'] });
  assertCode(() => assertHandoffComplete(assignment(), value), 'ASSIGNMENT_SCOPE_VIOLATION');
});

it('rejects a handoff without required verification', () => {
  const value = handoff({ verificationResults: [] });
  assertCode(() => assertHandoffComplete(assignment(), value), 'VERIFICATION_REQUIRED');
});

function roundTrip<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

function assertCode(action: () => unknown, code: string): void {
  assert.throws(action, (error) => error instanceof CoordinationDomainError && error.code === code);
}

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { CoordinationDomainError } from '../src/coordination/errors.js';
import { validateAssignment } from '../src/coordination/validators.js';
import {
  assertVerificationComplete,
  validateVerificationResult,
} from '../src/coordination/verification-service.js';
import { assignment, verification } from './coordination-fixtures.js';

it('requires a required criterion when verification is enabled', () => {
  const value = assignment({ completionCriteria: [] });
  assertCode(() => validateAssignment(value), 'VERIFICATION_REQUIRED');
});

it('rejects passed verification without evidence', () => {
  const value = verification({ evidence: [] });
  assertCode(() => validateVerificationResult(value), 'VERIFICATION_REQUIRED');
});

it('rejects passed verification without a timestamp', () => {
  const value = verification({ verifiedAt: null });
  assertCode(() => validateVerificationResult(value), 'VERIFICATION_REQUIRED');
});

it('rejects completion when the typed assignment has no required criterion', () => {
  const value = assignment({ completionCriteria: [] });
  assertCode(() => assertVerificationComplete(value, []), 'VERIFICATION_REQUIRED');
});

it('does not count an unevidenced typed pass as verification', () => {
  const result = verification({ evidence: [], verifiedAt: null });
  assertCode(() => assertVerificationComplete(assignment(), [result]), 'VERIFICATION_REQUIRED');
});

it('does not count a typed pass with a malformed timestamp', () => {
  const result = verification({ verifiedAt: 'not-a-timestamp' });
  assertCode(() => assertVerificationComplete(assignment(), [result]), 'VERIFICATION_REQUIRED');
});

it('does not count a typed pass with malformed evidence', () => {
  const result = verification({
    evidence: [{ kind: '', reference: '', sha256: 'bad' }],
  });
  assertCode(() => assertVerificationComplete(assignment(), [result]), 'VERIFICATION_REQUIRED');
});

it('accepts a passed result with evidence and a timestamp', () => {
  assert.doesNotThrow(() => validateVerificationResult(verification()));
  assert.doesNotThrow(() => assertVerificationComplete(assignment(), [verification()]));
});

function assertCode(action: () => unknown, code: string): void {
  assert.throws(action, (error) => error instanceof CoordinationDomainError && error.code === code);
}

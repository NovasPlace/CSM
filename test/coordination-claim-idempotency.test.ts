import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertClaimAvailable,
  claimsConflict,
} from '../src/coordination/claim-manager.js';
import { CoordinationDomainError } from '../src/coordination/errors.js';
import { claim, NOW } from './coordination-fixtures.js';

it('accepts a semantically identical claim replay', () => {
  const original = claim();
  assert.equal(claimsConflict(original, { ...original }), false);
  assert.doesNotThrow(() => assertClaimAvailable({ ...original }, [original], NOW));
});

it('conflicts a reused claim id with a different owner and assignment', () => {
  const original = claim({ mode: 'exclusive' });
  const mutated = claim({
    agentId: 'other-agent', assignmentId: 'other-assignment', mode: 'exclusive',
  });
  assert.equal(claimsConflict(original, mutated), true);
  assertCode(() => assertClaimAvailable(mutated, [original], NOW), 'RESOURCE_ALREADY_CLAIMED');
});

it('rejects a reused claim id even when its resource no longer overlaps', () => {
  const original = claim();
  const mutated = claim({ resourceId: 'src/other.ts' });
  assert.equal(claimsConflict(original, mutated), false);
  assertCode(() => assertClaimAvailable(mutated, [original], NOW), 'RESOURCE_ALREADY_CLAIMED');
});

function assertCode(action: () => unknown, code: string): void {
  assert.throws(action, (error) => error instanceof CoordinationDomainError && error.code === code);
}

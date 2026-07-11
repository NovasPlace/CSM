import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertClaimAvailable,
  assertClaimUsable,
  assertResourceAllowed,
  claimsConflict,
  claimsOverlap,
  isClaimExpired,
} from '../src/coordination/claim-manager.js';
import {
  addDependency,
  areDependenciesSatisfied,
  assertAcyclicDependencies,
  findDependencyCycle,
} from '../src/coordination/dependency-graph.js';
import { CoordinationDomainError } from '../src/coordination/errors.js';
import { claim, dependency, NOW, scope } from './coordination-fixtures.js';

it('accepts an acyclic dependency chain', () => {
  const values = [
    dependency(),
    dependency({ id: 'dependency-2', assignmentId: 'assignment-2', dependsOnAssignmentId: 'assignment-1' }),
  ];
  assert.doesNotThrow(() => assertAcyclicDependencies(values, 'workspace-1'));
});

it('finds a dependency cycle with its closing node', () => {
  const values = [
    dependency({ assignmentId: 'a', dependsOnAssignmentId: 'b' }),
    dependency({ id: 'd2', assignmentId: 'b', dependsOnAssignmentId: 'a' }),
  ];
  assert.deepEqual(findDependencyCycle(values, 'workspace-1'), ['a', 'b', 'a']);
});

it('rejects a dependency cycle', () => {
  const values = [
    dependency({ assignmentId: 'a', dependsOnAssignmentId: 'b' }),
    dependency({ id: 'd2', assignmentId: 'b', dependsOnAssignmentId: 'a' }),
  ];
  assertCode(() => assertAcyclicDependencies(values, 'workspace-1'), 'ASSIGNMENT_DEPENDENCY_UNRESOLVED');
});

it('isolates dependency graphs by workspace', () => {
  const values = [
    dependency({ workspaceId: 'one', assignmentId: 'a', dependsOnAssignmentId: 'b' }),
    dependency({ id: 'd2', workspaceId: 'two', assignmentId: 'b', dependsOnAssignmentId: 'a' }),
  ];
  assert.equal(findDependencyCycle(values, 'one'), null);
});

it('reports satisfied dependencies when every prerequisite completed', () => {
  const statuses = statusMap('workspace-1', [['assignment-0', 'completed']]);
  assert.equal(areDependenciesSatisfied('workspace-1', 'assignment-1', [dependency()], statuses), true);
});

it('reports unresolved dependency when a prerequisite is active', () => {
  const statuses = statusMap('workspace-1', [['assignment-0', 'active']]);
  assert.equal(areDependenciesSatisfied('workspace-1', 'assignment-1', [dependency()], statuses), false);
});

it('treats assignments without dependencies as ready', () => {
  assert.equal(areDependenciesSatisfied('workspace-1', 'assignment-9', [dependency()], new Map()), true);
});

it('ignores same-named dependencies from another workspace', () => {
  const foreign = dependency({ workspaceId: 'workspace-2' });
  const statuses = statusMap('workspace-2', [['assignment-0', 'active']]);
  assert.equal(areDependenciesSatisfied('workspace-1', 'assignment-1', [foreign], statuses), true);
});

it('adds a dependency without mutating the input', () => {
  const original = [dependency()];
  const result = addDependency(original, dependency({ id: 'd2', assignmentId: 'assignment-2' }));
  assert.equal(original.length, 1);
  assert.equal(result.length, 2);
});

it('makes duplicate dependency addition idempotent', () => {
  const original = [dependency()];
  assert.deepEqual(addDependency(original, dependency({ id: 'other-id' })), original);
});

it('rejects a cycle introduced by a new dependency', () => {
  const original = [dependency({ assignmentId: 'a', dependsOnAssignmentId: 'b' })];
  const candidate = dependency({ id: 'd2', assignmentId: 'b', dependsOnAssignmentId: 'a' });
  assertCode(() => addDependency(original, candidate), 'ASSIGNMENT_DEPENDENCY_UNRESOLVED');
});

it('overlaps a file claim with a region in the same file', () => {
  const region = scope({ resourceType: 'file_region', region: { startLine: 10, endLine: 20 } });
  assert.equal(claimsOverlap(scope(), region), true);
});

it('does not overlap different resources', () => {
  assert.equal(claimsOverlap(scope(), scope({ resourceId: 'src/other.ts' })), false);
});

it('detects overlapping line regions', () => {
  const left = scope({ resourceType: 'file_region', region: { startLine: 10, endLine: 20 } });
  const right = scope({ resourceType: 'file_region', region: { startLine: 20, endLine: 30 } });
  assert.equal(claimsOverlap(left, right), true);
});

it('allows disjoint line regions', () => {
  const left = scope({ resourceType: 'file_region', region: { startLine: 10, endLine: 19 } });
  const right = scope({ resourceType: 'file_region', region: { startLine: 20, endLine: 30 } });
  assert.equal(claimsOverlap(left, right), false);
});

it('conflicts overlapping writes from different agents', () => {
  assert.equal(claimsConflict(claim(), claim({ id: 'c2', agentId: 'other' })), true);
});

it('conflicts exclusive claims with reads', () => {
  const exclusive = claim({ mode: 'exclusive' });
  const read = claim({ id: 'c2', agentId: 'other', mode: 'read' });
  assert.equal(claimsConflict(exclusive, read), true);
});

it('allows non-exclusive reads beside a write', () => {
  const read = claim({ id: 'c2', agentId: 'other', mode: 'read' });
  assert.equal(claimsConflict(claim(), read), false);
});

it('conflicts distinct overlapping claims held by the same agent', () => {
  assert.equal(claimsConflict(claim(), claim({ id: 'c2', mode: 'exclusive' })), true);
});

it('makes replay of the same claim identity idempotent', () => {
  assert.equal(claimsConflict(claim(), claim()), false);
});

it('does not conflict inactive claims', () => {
  const released = claim({ id: 'c2', agentId: 'other', status: 'released' });
  assert.equal(claimsConflict(claim(), released), false);
});

it('detects lease expiration at the exact boundary', () => {
  assert.equal(isClaimExpired(claim({ leaseExpiresAt: NOW }), NOW), true);
});

it('accepts an active unbounded claim', () => {
  assert.doesNotThrow(() => assertClaimUsable(claim(), NOW));
});

it('rejects an expired claim', () => {
  assertCode(() => assertClaimUsable(claim({ status: 'expired' }), NOW), 'RESOURCE_CLAIM_EXPIRED');
});

it('rejects a conflicting available-claim request', () => {
  const candidate = claim();
  const existing = claim({ id: 'c2', agentId: 'other' });
  assertCode(() => assertClaimAvailable(candidate, [existing], NOW), 'RESOURCE_ALREADY_CLAIMED');
});

it('ignores expired existing claims during acquisition', () => {
  const expired = claim({ id: 'c2', agentId: 'other', leaseExpiresAt: NOW });
  assert.doesNotThrow(() => assertClaimAvailable(claim(), [expired], NOW));
});

it('allows a requested region inside a full-file scope', () => {
  const requested = scope({ resourceType: 'file_region', region: { startLine: 5, endLine: 8 } });
  assert.doesNotThrow(() => assertResourceAllowed(requested, [scope()]));
});

it('allows read access inside a write scope', () => {
  assert.doesNotThrow(() => assertResourceAllowed(scope({ mode: 'read' }), [scope()]));
});

it('rejects write access inside a read-only scope', () => {
  assertCode(() => assertResourceAllowed(scope(), [scope({ mode: 'read' })]), 'ASSIGNMENT_SCOPE_VIOLATION');
});

it('rejects a region extending outside the allowed range', () => {
  const allowed = scope({ resourceType: 'file_region', region: { startLine: 10, endLine: 20 } });
  const requested = scope({ resourceType: 'file_region', region: { startLine: 15, endLine: 25 } });
  assertCode(() => assertResourceAllowed(requested, [allowed]), 'ASSIGNMENT_SCOPE_VIOLATION');
});

function assertCode(action: () => unknown, code: string): void {
  assert.throws(action, (error) => error instanceof CoordinationDomainError && error.code === code);
}

function statusMap(
  workspaceId: string,
  entries: Array<[string, 'active' | 'completed']>,
): ReadonlyMap<string, ReadonlyMap<string, 'active' | 'completed'>> {
  return new Map([[workspaceId, new Map(entries)]]);
}

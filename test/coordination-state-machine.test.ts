import { it } from 'node:test';
import assert from 'node:assert/strict';
import { CoordinationDomainError } from '../src/coordination/errors.js';
import {
  isAssignmentTransitionAllowed,
  transitionAssignment,
  transitionWorkspace,
  type AssignmentTransitionContext,
} from '../src/coordination/task-state-machine.js';
import type { AssignmentStatus, WorkspaceStatus } from '../src/coordination/types.js';
import { assignment, NOW, workspace } from './coordination-fixtures.js';

const ASSIGNMENT_STATUSES: AssignmentStatus[] = [
  'queued', 'ready', 'assigned', 'active', 'blocked', 'review',
  'verified', 'completed', 'failed', 'cancelled',
];

const VALID_ASSIGNMENT: Array<[
  AssignmentStatus,
  AssignmentStatus,
  AssignmentTransitionContext,
]> = [
  ['queued', 'ready', { dependenciesSatisfied: true }],
  ['queued', 'cancelled', {}],
  ['ready', 'assigned', {}],
  ['ready', 'cancelled', {}],
  ['assigned', 'active', {}],
  ['assigned', 'cancelled', {}],
  ['active', 'blocked', { blockerSubmitted: true }],
  ['active', 'review', { deliverablesSubmitted: true }],
  ['active', 'failed', {}],
  ['active', 'cancelled', {}],
  ['blocked', 'active', {}],
  ['blocked', 'failed', {}],
  ['blocked', 'cancelled', {}],
  ['review', 'active', {}],
  ['review', 'verified', { verificationPassed: true }],
  ['review', 'failed', {}],
  ['verified', 'completed', { primaryAccepted: true }],
];

const WORKSPACE_STATUSES: WorkspaceStatus[] = [
  'planned', 'active', 'paused', 'completed', 'cancelled',
];

const VALID_WORKSPACE: Array<[WorkspaceStatus, WorkspaceStatus]> = [
  ['planned', 'active'], ['planned', 'cancelled'],
  ['active', 'paused'], ['active', 'completed'], ['active', 'cancelled'],
  ['paused', 'active'], ['paused', 'cancelled'],
];

for (const [current, target, context] of VALID_ASSIGNMENT) {
  it(`allows assignment ${current} -> ${target}`, () => {
    const result = transitionAssignment(assignment({ status: current }), target, 1, context);
    assert.equal(result.status, target);
    assert.equal(result.version, 2);
  });
}

for (const current of ASSIGNMENT_STATUSES) {
  for (const target of ASSIGNMENT_STATUSES) {
    const valid = current === target
      || VALID_ASSIGNMENT.some(([from, to]) => from === current && to === target);
    if (valid) continue;
    it(`rejects assignment ${current} -> ${target}`, () => {
      assert.equal(isAssignmentTransitionAllowed(current, target), false);
      assertCode(() => transitionAssignment(assignment({ status: current }), target, 1), 'INVALID_STATE_TRANSITION');
    });
  }
}

for (const [current, target] of VALID_WORKSPACE) {
  it(`allows workspace ${current} -> ${target}`, () => {
    const result = transitionWorkspace(workspace({ status: current }), target, 1, NOW);
    assert.equal(result.status, target);
    assert.equal(result.version, 2);
  });
}

for (const current of WORKSPACE_STATUSES) {
  for (const target of WORKSPACE_STATUSES) {
    const valid = current === target
      || VALID_WORKSPACE.some(([from, to]) => from === current && to === target);
    if (valid) continue;
    it(`rejects workspace ${current} -> ${target}`, () => {
      assertCode(() => transitionWorkspace(workspace({ status: current }), target, 1, NOW), 'INVALID_STATE_TRANSITION');
    });
  }
}

it('requires resolved dependencies before ready', () => {
  assertCode(() => transitionAssignment(assignment(), 'ready', 1), 'ASSIGNMENT_DEPENDENCY_UNRESOLVED');
});

it('requires an agent before assigned', () => {
  const value = assignment({ status: 'ready', assignedAgentId: null });
  assertCode(() => transitionAssignment(value, 'assigned', 1), 'INVALID_STATE_TRANSITION');
});

it('requires a structured blocker before blocked', () => {
  assertCode(() => transitionAssignment(assignment({ status: 'active' }), 'blocked', 1), 'INVALID_STATE_TRANSITION');
});

it('requires submitted deliverables before review', () => {
  assertCode(() => transitionAssignment(assignment({ status: 'active' }), 'review', 1), 'HANDOFF_INCOMPLETE');
});

it('requires verification before verified', () => {
  assertCode(() => transitionAssignment(assignment({ status: 'review' }), 'verified', 1), 'VERIFICATION_REQUIRED');
});

it('requires primary acceptance before completed', () => {
  assertCode(() => transitionAssignment(assignment({ status: 'verified' }), 'completed', 1), 'APPROVAL_REQUIRED');
});

it('requires configured user approval before completed', () => {
  const value = assignment({ status: 'verified', requiresUserApproval: true });
  assertCode(() => transitionAssignment(value, 'completed', 1, { primaryAccepted: true }), 'APPROVAL_REQUIRED');
});

it('accepts completed work after both approvals', () => {
  const value = assignment({ status: 'verified', requiresUserApproval: true });
  const result = transitionAssignment(value, 'completed', 1, {
    primaryAccepted: true, userApprovalGranted: true,
  });
  assert.equal(result.status, 'completed');
});

it('rejects stale assignment versions', () => {
  assertCode(() => transitionAssignment(assignment(), 'cancelled', 0), 'VERSION_CONFLICT');
});

it('rejects stale workspace versions', () => {
  assertCode(() => transitionWorkspace(workspace(), 'active', 0, NOW), 'VERSION_CONFLICT');
});

it('makes repeated assignment transitions idempotent', () => {
  const value = assignment({ status: 'active', version: 4 });
  assert.equal(transitionAssignment(value, 'active', 3), value);
});

it('makes repeated workspace transitions idempotent', () => {
  const value = workspace({ status: 'active', version: 4 });
  assert.equal(transitionWorkspace(value, 'active', 3, NOW), value);
});

it('rejects an old assignment retry outside the idempotency window', () => {
  const value = assignment({ status: 'active', version: 4 });
  assertCode(() => transitionAssignment(value, 'active', 2), 'VERSION_CONFLICT');
});

it('rejects an old workspace retry outside the idempotency window', () => {
  const value = workspace({ status: 'active', version: 4 });
  assertCode(() => transitionWorkspace(value, 'active', 2, NOW), 'VERSION_CONFLICT');
});

function assertCode(action: () => unknown, code: string): void {
  assert.throws(action, (error) => error instanceof CoordinationDomainError && error.code === code);
}

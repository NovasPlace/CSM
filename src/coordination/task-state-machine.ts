import { CoordinationDomainError } from './errors.js';
import type {
  AssignmentStatus,
  CoordinationAssignment,
  CoordinationWorkspace,
  WorkspaceStatus,
} from './types.js';

const ASSIGNMENT_TRANSITIONS: Record<AssignmentStatus, readonly AssignmentStatus[]> = {
  queued: ['ready', 'cancelled'],
  ready: ['assigned', 'cancelled'],
  assigned: ['active', 'cancelled'],
  active: ['blocked', 'review', 'failed', 'cancelled'],
  blocked: ['active', 'failed', 'cancelled'],
  review: ['active', 'verified', 'failed'],
  verified: ['completed'],
  completed: [],
  failed: [],
  cancelled: [],
};

const WORKSPACE_TRANSITIONS: Record<WorkspaceStatus, readonly WorkspaceStatus[]> = {
  planned: ['active', 'cancelled'],
  active: ['paused', 'completed', 'cancelled'],
  paused: ['active', 'cancelled'],
  completed: [],
  cancelled: [],
};

export interface AssignmentTransitionContext {
  dependenciesSatisfied?: boolean;
  blockerSubmitted?: boolean;
  deliverablesSubmitted?: boolean;
  verificationPassed?: boolean;
  primaryAccepted?: boolean;
  userApprovalGranted?: boolean;
}

export function transitionAssignment(
  assignment: CoordinationAssignment,
  target: AssignmentStatus,
  expectedVersion: number,
  context: AssignmentTransitionContext = {},
): CoordinationAssignment {
  if (assignment.status === target) return idempotentRetry(assignment, expectedVersion);
  assertVersion(assignment.version, expectedVersion);
  if (!ASSIGNMENT_TRANSITIONS[assignment.status].includes(target)) {
    invalidTransition('assignment', assignment.status, target);
  }
  assertAssignmentGuard(assignment, target, context);
  return { ...assignment, status: target, version: assignment.version + 1 };
}

export function transitionWorkspace(
  workspace: CoordinationWorkspace,
  target: WorkspaceStatus,
  expectedVersion: number,
  changedAt: string,
): CoordinationWorkspace {
  if (workspace.status === target) return idempotentRetry(workspace, expectedVersion);
  assertVersion(workspace.version, expectedVersion);
  if (!WORKSPACE_TRANSITIONS[workspace.status].includes(target)) {
    invalidTransition('workspace', workspace.status, target);
  }
  return {
    ...workspace,
    status: target,
    version: workspace.version + 1,
    updatedAt: changedAt,
    completedAt: target === 'completed' ? changedAt : workspace.completedAt,
  };
}

export function isAssignmentTransitionAllowed(
  current: AssignmentStatus,
  target: AssignmentStatus,
): boolean {
  return current === target || ASSIGNMENT_TRANSITIONS[current].includes(target);
}

function assertAssignmentGuard(
  assignment: CoordinationAssignment,
  target: AssignmentStatus,
  context: AssignmentTransitionContext,
): void {
  if (assignment.status === 'queued' && target === 'ready' && !context.dependenciesSatisfied) {
    throw new CoordinationDomainError('ASSIGNMENT_DEPENDENCY_UNRESOLVED', 'Assignment dependencies are unresolved');
  }
  if (assignment.status === 'ready' && target === 'assigned' && !assignment.assignedAgentId) {
    throw new CoordinationDomainError('INVALID_STATE_TRANSITION', 'Assigned state requires an agent');
  }
  if (assignment.status === 'active' && target === 'blocked' && !context.blockerSubmitted) {
    throw new CoordinationDomainError('INVALID_STATE_TRANSITION', 'Blocked state requires a structured blocker');
  }
  if (assignment.status === 'active' && target === 'review' && !context.deliverablesSubmitted) {
    throw new CoordinationDomainError('HANDOFF_INCOMPLETE', 'Review requires submitted deliverables');
  }
  assertCompletionGuards(assignment, target, context);
}

function assertCompletionGuards(
  assignment: CoordinationAssignment,
  target: AssignmentStatus,
  context: AssignmentTransitionContext,
): void {
  if (assignment.status === 'review' && target === 'verified'
    && assignment.requiresVerification && !context.verificationPassed) {
    throw new CoordinationDomainError('VERIFICATION_REQUIRED', 'Required verification has not passed');
  }
  if (assignment.status !== 'verified' || target !== 'completed') return;
  if (!context.primaryAccepted) {
    throw new CoordinationDomainError('APPROVAL_REQUIRED', 'Primary agent acceptance is required');
  }
  if (assignment.requiresUserApproval && !context.userApprovalGranted) {
    throw new CoordinationDomainError('APPROVAL_REQUIRED', 'User approval is required');
  }
}

function assertVersion(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new CoordinationDomainError('VERSION_CONFLICT', 'Expected version does not match current version', {
      expectedVersion: expected, actualVersion: actual,
    });
  }
}

function idempotentRetry<T extends { version: number }>(value: T, expected: number): T {
  if (expected === value.version || expected === value.version - 1) return value;
  assertVersion(value.version, expected);
  return value;
}

function invalidTransition(domain: string, current: string, target: string): never {
  throw new CoordinationDomainError('INVALID_STATE_TRANSITION', `Invalid ${domain} transition: ${current} -> ${target}`);
}

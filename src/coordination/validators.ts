import { CoordinationDomainError } from './errors.js';
import {
  requireArray,
  requireBoolean,
  requireEnum,
  requireInteger,
  requireNullableString,
  requireNullableTimestamp,
  requireRecord,
  requireString,
  requireStringArray,
  requireTimestamp,
  type UnknownRecord,
} from './schema-validation.js';
import type {
  CompletionCriterion,
  CoordinationAgent,
  CoordinationAssignment,
  CoordinationDependency,
  CoordinationWorkspace,
  DeliverableContract,
  ResourceClaim,
  ResourceRegion,
  ResourceScope,
} from './types.js';

const WORKSPACE_STATUSES = ['planned', 'active', 'paused', 'completed', 'cancelled'] as const;
const AGENT_ROLES = ['primary', 'research', 'implementation', 'review', 'security', 'verification', 'specialist'] as const;
const AGENT_STATUSES = ['idle', 'assigned', 'working', 'blocked', 'awaiting_review', 'complete', 'offline'] as const;
const ASSIGNMENT_STATUSES = ['queued', 'ready', 'assigned', 'active', 'blocked', 'review', 'verified', 'completed', 'failed', 'cancelled'] as const;
const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
const RESOURCE_TYPES = ['file', 'file_region', 'database_schema', 'database_table', 'service', 'configuration', 'external_resource'] as const;
const CLAIM_MODES = ['read', 'write', 'exclusive'] as const;
const CLAIM_STATUSES = ['active', 'released', 'expired', 'conflicted'] as const;

export function validateWorkspace(value: unknown): CoordinationWorkspace {
  const row = requireRecord(value, 'workspace');
  if (typeof row.primaryAgentId !== 'string' || row.primaryAgentId.trim().length === 0) {
    throw new CoordinationDomainError('PRIMARY_AGENT_REQUIRED', 'Primary agent is required');
  }
  const primaryAgentId = row.primaryAgentId;
  return {
    id: requireString(row, 'id'), projectId: requireString(row, 'projectId'),
    sessionId: requireNullableString(row, 'sessionId'), title: requireString(row, 'title'),
    objective: requireString(row, 'objective'), primaryAgentId,
    status: requireEnum(row, 'status', WORKSPACE_STATUSES), version: requireInteger(row, 'version', 1),
    createdAt: requireTimestamp(row, 'createdAt'), updatedAt: requireTimestamp(row, 'updatedAt'),
    completedAt: requireNullableTimestamp(row, 'completedAt'),
  };
}

export function validateAgent(value: unknown): CoordinationAgent {
  const row = requireRecord(value, 'agent');
  return {
    id: requireString(row, 'id'), workspaceId: requireString(row, 'workspaceId'),
    role: requireEnum(row, 'role', AGENT_ROLES), status: requireEnum(row, 'status', AGENT_STATUSES),
    capabilities: requireStringArray(row, 'capabilities'),
    activeAssignmentId: requireNullableString(row, 'activeAssignmentId'),
    lastHeartbeatAt: requireNullableTimestamp(row, 'lastHeartbeatAt'),
  };
}

export function validateAssignment(value: unknown): CoordinationAssignment {
  const row = requireRecord(value, 'assignment');
  const result: CoordinationAssignment = {
    id: requireString(row, 'id'), workspaceId: requireString(row, 'workspaceId'),
    parentAssignmentId: requireNullableString(row, 'parentAssignmentId'),
    assignedAgentId: requireNullableString(row, 'assignedAgentId'),
    title: requireString(row, 'title'), objective: requireString(row, 'objective'),
    instructions: requireString(row, 'instructions'),
    status: requireEnum(row, 'status', ASSIGNMENT_STATUSES),
    priority: requireInteger(row, 'priority'), risk: requireEnum(row, 'risk', RISK_LEVELS),
    allowedResources: requireArray(row, 'allowedResources').map(validateResourceScope),
    requiredDeliverables: requireArray(row, 'requiredDeliverables').map(validateDeliverableContract),
    completionCriteria: requireArray(row, 'completionCriteria').map(validateCompletionCriterion),
    requiresVerification: requireBoolean(row, 'requiresVerification'),
    requiresUserApproval: requireBoolean(row, 'requiresUserApproval'),
    version: requireInteger(row, 'version', 1),
  };
  assertAssignmentConsistency(result);
  return result;
}

export function validateDependency(value: unknown): CoordinationDependency {
  const row = requireRecord(value, 'dependency');
  const dependency = {
    id: requireString(row, 'id'), workspaceId: requireString(row, 'workspaceId'),
    assignmentId: requireString(row, 'assignmentId'),
    dependsOnAssignmentId: requireString(row, 'dependsOnAssignmentId'),
  };
  if (dependency.assignmentId === dependency.dependsOnAssignmentId) {
    throw new CoordinationDomainError('ASSIGNMENT_DEPENDENCY_UNRESOLVED', 'Assignment cannot depend on itself');
  }
  return dependency;
}

export function validateResourceScope(value: unknown): ResourceScope {
  const row = requireRecord(value, 'resource scope');
  const resourceType = requireEnum(row, 'resourceType', RESOURCE_TYPES);
  const region = validateRegion(row.region);
  if (resourceType === 'file_region' && !region) {
    throw new CoordinationDomainError('ASSIGNMENT_SCOPE_VIOLATION', 'File-region scope requires a region');
  }
  return {
    resourceType, resourceId: requireString(row, 'resourceId'), region,
    mode: requireEnum(row, 'mode', CLAIM_MODES),
  };
}

export function validateClaim(value: unknown): ResourceClaim {
  const row = requireRecord(value, 'resource claim');
  return {
    ...validateResourceScope(row), id: requireString(row, 'id'),
    workspaceId: requireString(row, 'workspaceId'),
    assignmentId: requireString(row, 'assignmentId'), agentId: requireString(row, 'agentId'),
    status: requireEnum(row, 'status', CLAIM_STATUSES),
    leaseExpiresAt: requireNullableTimestamp(row, 'leaseExpiresAt'),
  };
}

export function validatePrimaryAgentRoster(
  workspace: CoordinationWorkspace,
  agents: readonly CoordinationAgent[],
): void {
  const primaries = agents.filter((agent) =>
    agent.workspaceId === workspace.id && agent.role === 'primary');
  if (primaries.length !== 1 || primaries[0].id !== workspace.primaryAgentId) {
    throw new CoordinationDomainError('PRIMARY_AGENT_REQUIRED', 'Workspace requires exactly one matching primary agent', {
      workspaceId: workspace.id, primaryCount: primaries.length,
    });
  }
}

function validateRegion(value: unknown): ResourceRegion | null {
  if (value === null) return null;
  const row = requireRecord(value, 'resource region');
  const startLine = requireOptionalLine(row, 'startLine');
  const endLine = requireOptionalLine(row, 'endLine');
  if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
    throw new TypeError('endLine must be greater than or equal to startLine');
  }
  return { startLine, endLine };
}

function requireOptionalLine(row: UnknownRecord, key: string): number | undefined {
  if (row[key] === undefined) return undefined;
  return requireInteger(row, key, 1);
}

function validateDeliverableContract(value: unknown): DeliverableContract {
  return validateRequiredDefinition(value, 'deliverable contract');
}

function validateCompletionCriterion(value: unknown): CompletionCriterion {
  return validateRequiredDefinition(value, 'completion criterion');
}

function validateRequiredDefinition(value: unknown, label: string): DeliverableContract {
  const row = requireRecord(value, label);
  return {
    id: requireString(row, 'id'), description: requireString(row, 'description'),
    required: requireBoolean(row, 'required'),
  };
}

function assertAssignmentConsistency(assignment: CoordinationAssignment): void {
  if (assignment.parentAssignmentId === assignment.id) {
    throw new CoordinationDomainError('ASSIGNMENT_DEPENDENCY_UNRESOLVED', 'Assignment cannot parent itself');
  }
  const ownedStates = new Set([
    'assigned', 'active', 'blocked', 'review', 'verified', 'completed',
  ]);
  if (ownedStates.has(assignment.status) && !assignment.assignedAgentId) {
    throw new CoordinationDomainError('INVALID_STATE_TRANSITION', 'Assignment status requires an assigned agent');
  }
  const requiredCriteria = assignment.completionCriteria.filter((criterion) => criterion.required);
  if (assignment.requiresVerification && requiredCriteria.length === 0) {
    throw new CoordinationDomainError('VERIFICATION_REQUIRED', 'Verification requires at least one required criterion');
  }
}

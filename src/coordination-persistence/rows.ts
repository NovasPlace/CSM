import {
  validateAgent,
  validateAssignment,
  validateClaim,
  validateWorkspace,
} from '../coordination/validators.js';
import { validateCoordinationEvent } from '../coordination/event-service.js';
import type {
  CoordinationAgent,
  CoordinationAssignment,
  CoordinationEvent,
  CoordinationWorkspace,
  ResourceClaim,
} from '../coordination/types.js';
import { CoordinationPersistenceError } from './errors.js';

type Row = Record<string, unknown>;

export function mapWorkspace(value: unknown): CoordinationWorkspace {
  const row = record(value);
  return validateWorkspace({
    id: row.id, projectId: row.project_id, sessionId: row.session_id,
    title: row.title, objective: row.objective, primaryAgentId: row.primary_agent_id,
    status: row.status, version: number(row.version), createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at), completedAt: nullableTimestamp(row.completed_at),
  });
}

export function mapAgent(value: unknown): CoordinationAgent {
  const row = record(value);
  return validateAgent({
    id: row.id, workspaceId: row.workspace_id, role: row.role, status: row.status,
    capabilities: row.capabilities, activeAssignmentId: row.active_assignment_id,
    lastHeartbeatAt: nullableTimestamp(row.last_heartbeat_at),
  });
}

export function mapAssignment(value: unknown): CoordinationAssignment {
  const row = record(value);
  return validateAssignment({
    id: row.id, workspaceId: row.workspace_id, parentAssignmentId: row.parent_assignment_id,
    assignedAgentId: row.assigned_agent_id, title: row.title, objective: row.objective,
    instructions: row.instructions, status: row.status, priority: number(row.priority), risk: row.risk,
    allowedResources: row.allowed_resources, requiredDeliverables: row.required_deliverables,
    completionCriteria: row.completion_criteria, requiresVerification: row.requires_verification,
    requiresUserApproval: row.requires_user_approval, version: number(row.version),
  });
}

export function mapClaim(value: unknown): ResourceClaim {
  const row = record(value);
  const hasRegion = row.has_region === true;
  return validateClaim({
    id: row.id, workspaceId: row.workspace_id, assignmentId: row.assignment_id,
    agentId: row.agent_id, resourceType: row.resource_type, resourceId: row.resource_id,
    region: hasRegion ? { startLine: optionalNumber(row.start_line), endLine: optionalNumber(row.end_line) } : null,
    mode: row.mode, status: row.status, leaseExpiresAt: nullableTimestamp(row.lease_expires_at),
  });
}

export function mapEvent(value: unknown): CoordinationEvent {
  const row = record(value);
  return validateCoordinationEvent({
    id: row.id, workspaceId: row.workspace_id, assignmentId: row.assignment_id,
    actorAgentId: row.actor_agent_id, type: row.type, payload: row.payload,
    sequence: number(row.sequence), occurredAt: timestamp(row.occurred_at),
  });
}

function record(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CoordinationPersistenceError('CORRUPT_RECORD', 'Database returned a non-record row');
  }
  return value as Row;
}

function number(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new CoordinationPersistenceError('CORRUPT_RECORD', 'Database returned an unsafe integer');
  }
  return parsed;
}

function optionalNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : number(value);
}

function timestamp(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value;
  throw new CoordinationPersistenceError('CORRUPT_RECORD', 'Database returned an invalid timestamp');
}

function nullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : timestamp(value);
}

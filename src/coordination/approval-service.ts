import { CoordinationDomainError } from './errors.js';
import {
  requireEnum,
  requireJsonValue,
  requireNullableString,
  requireNullableTimestamp,
  requireRecord,
  requireString,
} from './schema-validation.js';
import type { ApprovalRequest } from './types.js';

const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'revoked'] as const;
const APPROVAL_RISKS = ['medium', 'high', 'critical'] as const;

export function validateApprovalRequest(value: unknown): ApprovalRequest {
  const row = requireRecord(value, 'approval request');
  return {
    id: requireString(row, 'id'), workspaceId: requireString(row, 'workspaceId'),
    assignmentId: requireNullableString(row, 'assignmentId'),
    requestedByAgentId: requireString(row, 'requestedByAgentId'),
    actionType: requireString(row, 'actionType'),
    risk: requireEnum(row, 'risk', APPROVAL_RISKS),
    actionPreview: requireJsonValue(row.actionPreview, 'actionPreview'),
    rationale: requireString(row, 'rationale'),
    status: requireEnum(row, 'status', APPROVAL_STATUSES),
    expiresAt: requireNullableTimestamp(row, 'expiresAt'),
  };
}

export function isApprovalExpired(approval: ApprovalRequest, now: string): boolean {
  if (approval.status === 'expired') return true;
  return approval.expiresAt !== null && Date.parse(approval.expiresAt) <= Date.parse(now);
}

export function assertApprovalPending(approval: ApprovalRequest, now: string): void {
  assertNotExpired(approval, now);
  if (approval.status !== 'pending') {
    throw new CoordinationDomainError('APPROVAL_REQUIRED', 'Approval request is not pending');
  }
}

export function assertApprovalGranted(approval: ApprovalRequest, now: string): void {
  assertNotExpired(approval, now);
  if (approval.status !== 'approved') {
    throw new CoordinationDomainError('APPROVAL_REQUIRED', 'Required approval was not granted');
  }
}

function assertNotExpired(approval: ApprovalRequest, now: string): void {
  if (isApprovalExpired(approval, now)) {
    throw new CoordinationDomainError('APPROVAL_EXPIRED', 'Approval request has expired', {
      approvalId: approval.id,
    });
  }
}

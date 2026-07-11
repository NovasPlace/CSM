import { CoordinationDomainError } from './errors.js';
import type { ClaimMode, ResourceClaim, ResourceRegion, ResourceScope } from './types.js';

export function claimsOverlap(left: ResourceScope, right: ResourceScope): boolean {
  if (resourceFamily(left) !== resourceFamily(right) || left.resourceId !== right.resourceId) {
    return false;
  }
  return regionsOverlap(left.region, right.region);
}

export function claimsConflict(left: ResourceClaim, right: ResourceClaim): boolean {
  if (left.workspaceId !== right.workspaceId || sameClaimReplay(left, right)) return false;
  if (left.status !== 'active' || right.status !== 'active' || !claimsOverlap(left, right)) return false;
  return left.mode === 'exclusive' || right.mode === 'exclusive'
    || (left.mode === 'write' && right.mode === 'write');
}

export function isClaimExpired(claim: ResourceClaim, now: string): boolean {
  if (!claim.leaseExpiresAt) return false;
  return Date.parse(claim.leaseExpiresAt) <= Date.parse(now);
}

export function assertClaimUsable(claim: ResourceClaim, now: string): void {
  if (claim.status === 'expired' || isClaimExpired(claim, now)) {
    throw new CoordinationDomainError('RESOURCE_CLAIM_EXPIRED', 'Resource claim has expired', {
      claimId: claim.id,
    });
  }
  if (claim.status !== 'active') {
    throw new CoordinationDomainError('ASSIGNMENT_SCOPE_VIOLATION', 'Resource claim is not active');
  }
}

export function assertClaimAvailable(
  candidate: ResourceClaim,
  existing: readonly ResourceClaim[],
  now: string,
): void {
  const reused = existing.find((claim) => claim.id === candidate.id);
  if (reused && !sameClaimReplay(candidate, reused)) {
    throw new CoordinationDomainError('RESOURCE_ALREADY_CLAIMED', 'Claim id was reused with different content', {
      claimId: candidate.id,
    });
  }
  if (reused) return;
  const conflict = existing.find((claim) =>
    !isClaimExpired(claim, now) && claimsConflict(candidate, claim));
  if (conflict) {
    throw new CoordinationDomainError('RESOURCE_ALREADY_CLAIMED', 'Resource conflicts with an active claim', {
      candidateId: candidate.id, conflictingClaimId: conflict.id,
    });
  }
}

export function assertResourceAllowed(
  requested: ResourceScope,
  allowed: readonly ResourceScope[],
): void {
  if (!allowed.some((scope) => containsScope(scope, requested))) {
    throw new CoordinationDomainError('ASSIGNMENT_SCOPE_VIOLATION', 'Resource is outside assignment scope', {
      resourceId: requested.resourceId,
    });
  }
}

function containsScope(allowed: ResourceScope, requested: ResourceScope): boolean {
  if (resourceFamily(allowed) !== resourceFamily(requested)) return false;
  if (allowed.resourceId !== requested.resourceId || !modeAllows(allowed.mode, requested.mode)) return false;
  return regionContains(allowed.region, requested.region);
}

function resourceFamily(scope: ResourceScope): string {
  return scope.resourceType === 'file_region' ? 'file' : scope.resourceType;
}

function modeAllows(allowed: ClaimMode, requested: ClaimMode): boolean {
  if (allowed === 'exclusive') return true;
  if (allowed === 'write') return requested === 'write' || requested === 'read';
  return requested === 'read';
}

function regionsOverlap(left: ResourceRegion | null, right: ResourceRegion | null): boolean {
  if (!left || !right) return true;
  const leftStart = left.startLine ?? 1;
  const leftEnd = left.endLine ?? Number.MAX_SAFE_INTEGER;
  const rightStart = right.startLine ?? 1;
  const rightEnd = right.endLine ?? Number.MAX_SAFE_INTEGER;
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

function regionContains(allowed: ResourceRegion | null, requested: ResourceRegion | null): boolean {
  if (!allowed) return true;
  if (!requested) return false;
  const allowedStart = allowed.startLine ?? 1;
  const allowedEnd = allowed.endLine ?? Number.MAX_SAFE_INTEGER;
  const requestedStart = requested.startLine ?? 1;
  const requestedEnd = requested.endLine ?? Number.MAX_SAFE_INTEGER;
  return allowedStart <= requestedStart && allowedEnd >= requestedEnd;
}

function sameClaimReplay(left: ResourceClaim, right: ResourceClaim): boolean {
  return left.id === right.id
    && left.workspaceId === right.workspaceId
    && left.assignmentId === right.assignmentId
    && left.agentId === right.agentId
    && left.resourceType === right.resourceType
    && left.resourceId === right.resourceId
    && left.mode === right.mode
    && left.status === right.status
    && left.leaseExpiresAt === right.leaseExpiresAt
    && sameRegion(left.region, right.region);
}

function sameRegion(left: ResourceRegion | null, right: ResourceRegion | null): boolean {
  if (!left || !right) return left === right;
  return left.startLine === right.startLine && left.endLine === right.endLine;
}

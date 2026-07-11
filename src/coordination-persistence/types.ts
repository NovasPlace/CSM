import type {
  CoordinationAgent,
  CoordinationAssignment,
  CoordinationEvent,
  CoordinationWorkspace,
  ResourceClaim,
  VerificationResult,
} from '../coordination/types.js';

export interface CreateWorkspaceRequest {
  workspace: CoordinationWorkspace;
  primaryAgent: CoordinationAgent;
  idempotencyKey: string;
}

export interface RegisterAgentRequest {
  workspaceId: string;
  actorAgentId: string;
  agent: CoordinationAgent;
  expectedWorkspaceVersion: number;
  idempotencyKey: string;
}

export interface CreateAssignmentRequest {
  assignment: CoordinationAssignment;
  dependencyIds: string[];
  actorAgentId: string;
  expectedWorkspaceVersion: number;
  idempotencyKey: string;
}

export interface CompleteAssignmentRequest {
  workspaceId: string;
  assignmentId: string;
  actorAgentId: string;
  expectedWorkspaceVersion: number;
  expectedAssignmentVersion: number;
  verificationResults: VerificationResult[];
  idempotencyKey: string;
}

export interface AcquireClaimRequest {
  claim: ResourceClaim;
  expectedAssignmentVersion: number;
  idempotencyKey: string;
}

export interface MutationResult {
  workspaceId: string;
  workspaceVersion: number;
  assignmentId?: string;
  assignmentVersion?: number;
  replayed: boolean;
}

export interface WorkspaceReadModel {
  workspace: CoordinationWorkspace;
  agents: CoordinationAgent[];
  assignments: CoordinationAssignment[];
  claims: ResourceClaim[];
  events: CoordinationEvent[];
  pageInfo: WorkspaceReadPageInfo;
}

export interface WorkspaceReadOptions {
  agentLimit?: number;
  assignmentLimit?: number;
  claimLimit?: number;
  eventLimit?: number;
}

export interface WorkspaceReadPageInfo {
  agentsHasMore: boolean;
  assignmentsHasMore: boolean;
  claimsHasMore: boolean;
  eventsHasMore: boolean;
}

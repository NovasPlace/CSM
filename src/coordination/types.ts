export type WorkspaceStatus = 'planned' | 'active' | 'paused' | 'completed' | 'cancelled';
export type AgentRole = 'primary' | 'research' | 'implementation' | 'review'
  | 'security' | 'verification' | 'specialist';
export type AgentStatus = 'idle' | 'assigned' | 'working' | 'blocked'
  | 'awaiting_review' | 'complete' | 'offline';
export type AssignmentStatus = 'queued' | 'ready' | 'assigned' | 'active'
  | 'blocked' | 'review' | 'verified' | 'completed' | 'failed' | 'cancelled';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type ResourceType = 'file' | 'file_region' | 'database_schema'
  | 'database_table' | 'service' | 'configuration' | 'external_resource';
export type ClaimMode = 'read' | 'write' | 'exclusive';
export type ClaimStatus = 'active' | 'released' | 'expired' | 'conflicted';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'revoked';
export type VerificationStatus = 'pending' | 'passed' | 'failed' | 'waived';

export interface CoordinationWorkspace {
  id: string;
  projectId: string;
  sessionId: string | null;
  title: string;
  objective: string;
  primaryAgentId: string;
  status: WorkspaceStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface CoordinationAgent {
  id: string;
  workspaceId: string;
  role: AgentRole;
  status: AgentStatus;
  capabilities: string[];
  activeAssignmentId: string | null;
  lastHeartbeatAt: string | null;
}

export interface ResourceRegion {
  startLine?: number;
  endLine?: number;
}

export interface ResourceScope {
  resourceType: ResourceType;
  resourceId: string;
  region: ResourceRegion | null;
  mode: ClaimMode;
}

export interface DeliverableContract {
  id: string;
  description: string;
  required: boolean;
}

export interface CompletionCriterion {
  id: string;
  description: string;
  required: boolean;
}

export interface CoordinationAssignment {
  id: string;
  workspaceId: string;
  parentAssignmentId: string | null;
  assignedAgentId: string | null;
  title: string;
  objective: string;
  instructions: string;
  status: AssignmentStatus;
  priority: number;
  risk: RiskLevel;
  allowedResources: ResourceScope[];
  requiredDeliverables: DeliverableContract[];
  completionCriteria: CompletionCriterion[];
  requiresVerification: boolean;
  requiresUserApproval: boolean;
  version: number;
}

export interface CoordinationDependency {
  id: string;
  workspaceId: string;
  assignmentId: string;
  dependsOnAssignmentId: string;
}

export interface ResourceClaim extends ResourceScope {
  id: string;
  workspaceId: string;
  assignmentId: string;
  agentId: string;
  status: ClaimStatus;
  leaseExpiresAt: string | null;
}

export interface EvidenceReference {
  kind: string;
  reference: string;
  sha256: string | null;
}

export interface Finding {
  id: string;
  severity: RiskLevel;
  summary: string;
  evidence: EvidenceReference[];
}

export interface Deliverable {
  contractId: string;
  reference: string;
  summary: string;
}

export interface RiskRecord {
  severity: RiskLevel;
  description: string;
}

export interface VerificationResult {
  id: string;
  criterionId: string;
  status: VerificationStatus;
  evidence: EvidenceReference[];
  verifiedAt: string | null;
}

export interface HandoffPacket {
  id: string;
  assignmentId: string;
  fromAgentId: string;
  toAgentId: string;
  summary: string;
  findings: Finding[];
  deliverables: Deliverable[];
  changedResources: string[];
  unresolvedQuestions: string[];
  risks: RiskRecord[];
  evidence: EvidenceReference[];
  verificationResults: VerificationResult[];
  createdAt: string;
}

export interface ApprovalRequest {
  id: string;
  workspaceId: string;
  assignmentId: string | null;
  requestedByAgentId: string;
  actionType: string;
  risk: Exclude<RiskLevel, 'low'>;
  actionPreview: unknown;
  rationale: string;
  status: ApprovalStatus;
  expiresAt: string | null;
}

export interface CoordinationEvent {
  id: string;
  workspaceId: string;
  assignmentId: string | null;
  actorAgentId: string;
  type: string;
  payload: Record<string, unknown>;
  sequence: number;
  occurredAt: string;
}

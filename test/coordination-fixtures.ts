import type {
  ApprovalRequest,
  CoordinationAgent,
  CoordinationAssignment,
  CoordinationDependency,
  CoordinationEvent,
  CoordinationWorkspace,
  EvidenceReference,
  HandoffPacket,
  ResourceClaim,
  ResourceScope,
  VerificationResult,
} from '../src/coordination/types.js';

export const NOW = '2026-07-10T12:00:00.000Z';

export function workspace(
  overrides: Partial<CoordinationWorkspace> = {},
): CoordinationWorkspace {
  return {
    id: 'workspace-1', projectId: 'project-1', sessionId: null,
    title: 'Enterprise coordination', objective: 'Ship a bounded coordination slice',
    primaryAgentId: 'agent-primary', status: 'planned', version: 1,
    createdAt: NOW, updatedAt: NOW, completedAt: null, ...overrides,
  };
}

export function agent(overrides: Partial<CoordinationAgent> = {}): CoordinationAgent {
  return {
    id: 'agent-primary', workspaceId: 'workspace-1', role: 'primary', status: 'idle',
    capabilities: ['planning'], activeAssignmentId: null, lastHeartbeatAt: null, ...overrides,
  };
}

export function scope(overrides: Partial<ResourceScope> = {}): ResourceScope {
  return {
    resourceType: 'file', resourceId: 'src/example.ts', region: null, mode: 'write', ...overrides,
  };
}

export function assignment(
  overrides: Partial<CoordinationAssignment> = {},
): CoordinationAssignment {
  return {
    id: 'assignment-1', workspaceId: 'workspace-1', parentAssignmentId: null,
    assignedAgentId: 'agent-worker', title: 'Implement domain', objective: 'Add pure domain code',
    instructions: 'Stay inside scope', status: 'queued', priority: 10, risk: 'medium',
    allowedResources: [scope()],
    requiredDeliverables: [{ id: 'code', description: 'Source change', required: true }],
    completionCriteria: [{ id: 'tests', description: 'Tests pass', required: true }],
    requiresVerification: true, requiresUserApproval: false, version: 1, ...overrides,
  };
}

export function dependency(
  overrides: Partial<CoordinationDependency> = {},
): CoordinationDependency {
  return {
    id: 'dependency-1', workspaceId: 'workspace-1', assignmentId: 'assignment-1',
    dependsOnAssignmentId: 'assignment-0', ...overrides,
  };
}

export function claim(overrides: Partial<ResourceClaim> = {}): ResourceClaim {
  return {
    ...scope(), id: 'claim-1', workspaceId: 'workspace-1', assignmentId: 'assignment-1',
    agentId: 'agent-worker', status: 'active', leaseExpiresAt: null, ...overrides,
  };
}

export function evidence(overrides: Partial<EvidenceReference> = {}): EvidenceReference {
  return { kind: 'test', reference: 'test/output.txt', sha256: null, ...overrides };
}

export function verification(
  overrides: Partial<VerificationResult> = {},
): VerificationResult {
  return {
    id: 'verification-1', criterionId: 'tests', status: 'passed',
    evidence: [evidence()], verifiedAt: NOW, ...overrides,
  };
}

export function handoff(overrides: Partial<HandoffPacket> = {}): HandoffPacket {
  return {
    id: 'handoff-1', assignmentId: 'assignment-1', fromAgentId: 'agent-worker',
    toAgentId: 'agent-primary', summary: 'Implemented and tested', findings: [],
    deliverables: [{ contractId: 'code', reference: 'src/example.ts', summary: 'Pure module' }],
    changedResources: ['src/example.ts'], unresolvedQuestions: [], risks: [],
    evidence: [evidence()], verificationResults: [verification()], createdAt: NOW, ...overrides,
  };
}

export function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'approval-1', workspaceId: 'workspace-1', assignmentId: 'assignment-1',
    requestedByAgentId: 'agent-primary', actionType: 'assignment.complete', risk: 'high',
    actionPreview: {}, rationale: 'Consequential completion', status: 'pending',
    expiresAt: '2026-07-10T13:00:00.000Z', ...overrides,
  };
}

export function event(overrides: Partial<CoordinationEvent> = {}): CoordinationEvent {
  return {
    id: 'event-1', workspaceId: 'workspace-1', assignmentId: 'assignment-1',
    actorAgentId: 'agent-primary', type: 'assignment.created', payload: {},
    sequence: 1, occurredAt: NOW, ...overrides,
  };
}

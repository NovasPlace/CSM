import type { AssignmentContextInput, ContextReference } from '../src/coordination/context-packet.js';
import type { CoordinationAssignment, ResourceScope } from '../src/coordination/types.js';

export const fileScope: ResourceScope = {
  resourceType: 'file', resourceId: 'src/a.ts', region: null, mode: 'write',
};

export function assignment(overrides: Partial<CoordinationAssignment> = {}): CoordinationAssignment {
  return {
    id: 'assignment-1', workspaceId: 'workspace-1', parentAssignmentId: null,
    assignedAgentId: 'agent-1', title: 'Bounded task', objective: 'Repair A',
    instructions: 'Change only A', status: 'assigned', priority: 1, risk: 'low',
    allowedResources: [fileScope], requiredDeliverables: [], completionCriteria: [],
    requiresVerification: true, requiresUserApproval: false, version: 1, ...overrides,
  };
}

export function reference(id: string, resource: ResourceScope | null = fileScope): ContextReference {
  return { id, content: `context ${id}`, resource, sensitive: false };
}

export function contextInput(overrides: Partial<AssignmentContextInput> = {}): AssignmentContextInput {
  return {
    assignment: assignment(), agentId: 'agent-1', outputSchema: { type: 'object' },
    constraints: ['No broad edits'], memories: [reference('memory')],
    decisions: [reference('decision')], projectRules: ['Run tests'],
    dependencyOutputs: [reference('dependency')], verificationRequirements: ['Build'],
    exclusions: ['No credentials'], ...overrides,
  };
}

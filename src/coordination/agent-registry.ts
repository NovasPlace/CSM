import { CoordinationDomainError } from './errors.js';
import type { CoordinationAgent } from './types.js';

export function assertAssignmentAuthority(
  actor: CoordinationAgent,
  target: CoordinationAgent,
): void {
  if (actor.workspaceId !== target.workspaceId) {
    throw new CoordinationDomainError('ASSIGNMENT_SCOPE_VIOLATION', 'Agents belong to different workspaces');
  }
  if (actor.role !== 'primary') {
    throw new CoordinationDomainError('ASSIGNMENT_SCOPE_VIOLATION', 'Only the primary agent can assign work');
  }
}

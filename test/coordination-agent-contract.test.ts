import { it } from 'node:test';
import assert from 'node:assert/strict';
import { assertAssignmentAuthority } from '../src/coordination/agent-registry.js';
import { CoordinationDomainError } from '../src/coordination/errors.js';
import { agent } from './coordination-fixtures.js';

it('allows the primary agent to assign a sub-agent', () => {
  const target = agent({ id: 'worker', role: 'implementation' });
  assert.doesNotThrow(() => assertAssignmentAuthority(agent(), target));
});

it('rejects a sub-agent assigning the primary agent', () => {
  const actor = agent({ id: 'worker', role: 'implementation' });
  assertCode(() => assertAssignmentAuthority(actor, agent()), 'ASSIGNMENT_SCOPE_VIOLATION');
});

it('rejects a sub-agent assigning a peer sub-agent', () => {
  const actor = agent({ id: 'researcher', role: 'research' });
  const target = agent({ id: 'worker', role: 'implementation' });
  assertCode(() => assertAssignmentAuthority(actor, target), 'ASSIGNMENT_SCOPE_VIOLATION');
});

it('rejects assignment authority across workspaces', () => {
  const target = agent({ id: 'worker', role: 'implementation', workspaceId: 'other' });
  assertCode(() => assertAssignmentAuthority(agent(), target), 'ASSIGNMENT_SCOPE_VIOLATION');
});

function assertCode(action: () => unknown, code: string): void {
  assert.throws(action, (error) => error instanceof CoordinationDomainError && error.code === code);
}

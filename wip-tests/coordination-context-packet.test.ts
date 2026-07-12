import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAssignmentContextPacket } from '../src/coordination/context-packet.js';
import type { ClaimMode, ResourceScope } from '../src/coordination/types.js';
import { assignment, contextInput, fileScope, reference } from './coordination-context-fixture.js';

  it('contains only the bounded assignment contract', () => {
    const packet = buildAssignmentContextPacket(contextInput());
    assert.equal(packet.assignmentId, 'assignment-1');
    assert.deepEqual(packet.allowedResources, [fileScope]);
    assert.equal('sessionHistory' in packet, false);
  });

  it('rejects delivery to a different agent', () => {
    assert.throws(() => buildAssignmentContextPacket(contextInput({ agentId: 'agent-2' })), /assigned agent/);
  });

  it('excludes sensitive references', () => {
    const secret = { ...reference('secret'), sensitive: true };
    assert.deepEqual(buildAssignmentContextPacket(contextInput({ memories: [secret] })).memories, []);
  });

  it('excludes out-of-scope references', () => {
    const other = reference('other', { ...fileScope, resourceId: 'src/b.ts' });
    assert.deepEqual(buildAssignmentContextPacket(contextInput({ decisions: [other] })).decisions, []);
  });

  it('allows resource-neutral workspace context', () => {
    const packet = buildAssignmentContextPacket(contextInput({ memories: [reference('rule', null)] }));
    assert.deepEqual(packet.memories.map((item) => item.id), ['rule']);
  });

  it('enforces bounded region containment', () => {
    const allowed: ResourceScope = { ...fileScope, resourceType: 'file_region',
      region: { startLine: 10, endLine: 20 } };
    const inside = reference('inside', { ...allowed, region: { startLine: 12, endLine: 18 } });
    const outside = reference('outside', { ...allowed, region: { startLine: 9, endLine: 18 } });
    const packet = buildAssignmentContextPacket(contextInput({
      assignment: assignment({ allowedResources: [allowed] }), memories: [inside, outside],
    }));
    assert.deepEqual(packet.memories.map((item) => item.id), ['inside']);
  });

  it('accepts a bounded region under a whole-file grant', () => {
    const region = reference('region', { ...fileScope, resourceType: 'file_region',
      region: { startLine: 10, endLine: 20 } });
    const packet = buildAssignmentContextPacket(contextInput({ memories: [region] }));
    assert.deepEqual(packet.memories.map((item) => item.id), ['region']);
  });

  it('rejects a whole file under a bounded-region grant', () => {
    const bounded: ResourceScope = { ...fileScope, resourceType: 'file_region',
      region: { startLine: 10, endLine: 20 } };
    const packet = buildAssignmentContextPacket(contextInput({
      assignment: assignment({ allowedResources: [bounded] }), memories: [reference('whole')],
    }));
    assert.deepEqual(packet.memories, []);
  });

  it('returns defensive copies', () => {
    const source = contextInput();
    const packet = buildAssignmentContextPacket(source);
    packet.allowedResources[0].resourceId = 'changed';
    assert.equal(source.assignment.allowedResources[0].resourceId, 'src/a.ts');
  });
describe('canonical mode containment', () => {
  const cases: Array<[ClaimMode, ClaimMode, boolean]> = [
    ['read', 'read', true], ['read', 'write', false], ['read', 'exclusive', false],
    ['write', 'read', true], ['write', 'write', true], ['write', 'exclusive', false],
    ['exclusive', 'read', true], ['exclusive', 'write', true], ['exclusive', 'exclusive', true],
  ];
  for (const [allowed, requested, included] of cases) {
    it(`${allowed} ${included ? 'allows' : 'rejects'} ${requested}`, () => {
      const packet = buildAssignmentContextPacket(contextInput({
        assignment: assignment({ allowedResources: [{ ...fileScope, mode: allowed }] }),
        memories: [reference('ref', { ...fileScope, mode: requested })],
      }));
      assert.equal(packet.memories.length, included ? 1 : 0);
    });
  }
});

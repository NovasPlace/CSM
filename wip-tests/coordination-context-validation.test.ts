import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAssignmentContextPacket } from '../src/coordination/context-packet.js';
import type { ContextReference } from '../src/coordination/context-packet.js';
import type { ResourceScope } from '../src/coordination/types.js';
import { assignment, contextInput, fileScope, reference } from './coordination-context-fixture.js';

function malformedRegion(region: unknown): ContextReference {
  return reference('bad', { ...fileScope, resourceType: 'file_region',
    region: region as ResourceScope['region'] });
}

  const regions: Array<[string, unknown]> = [
    ['reversed', { startLine: 20, endLine: 10 }],
    ['zero', { startLine: 0, endLine: 10 }],
    ['negative', { startLine: -5, endLine: 10 }],
    ['infinite', { startLine: Infinity, endLine: Infinity }],
    ['NaN', { startLine: NaN, endLine: 10 }],
    ['fractional', { startLine: 1.5, endLine: 10 }],
  ];
  for (const [label, region] of regions) {
    it(`rejects ${label} coordinates`, () => {
      assert.throws(() => buildAssignmentContextPacket(contextInput({
        memories: [malformedRegion(region)],
      })), /Line|region|startLine|endLine/i);
    });
  }

  it('rejects a missing resource type', () => {
    const bad = reference('bad', { resourceId: 'src/a.ts', region: null, mode: 'write' } as ResourceScope);
    assert.throws(() => buildAssignmentContextPacket(contextInput({ memories: [bad] })), /resourceType/);
  });

  it('rejects an invalid resource type', () => {
    const bad = reference('bad', { ...fileScope, resourceType: 'invalid' as 'file' });
    assert.throws(() => buildAssignmentContextPacket(contextInput({ memories: [bad] })), /resourceType/);
  });

  it('rejects an empty resource id', () => {
    const bad = reference('bad', { ...fileScope, resourceId: '' });
    assert.throws(() => buildAssignmentContextPacket(contextInput({ memories: [bad] })), /resourceId/);
  });

  it('rejects a missing mode', () => {
    const bad = reference('bad', { resourceType: 'file', resourceId: 'src/a.ts', region: null } as ResourceScope);
    assert.throws(() => buildAssignmentContextPacket(contextInput({ memories: [bad] })), /mode/);
  });

  it('rejects a region resource without coordinates', () => {
    const bad = reference('bad', { ...fileScope, resourceType: 'file_region', region: null });
    assert.throws(() => buildAssignmentContextPacket(contextInput({ memories: [bad] })), /region/i);
  });

  it('rejects malformed allowed scopes', () => {
    const bad = { resourceId: 'src/a.ts', region: null, mode: 'write' } as ResourceScope;
    assert.throws(() => buildAssignmentContextPacket(contextInput({
      assignment: assignment({ allowedResources: [bad] }),
    })), /resourceType/);
  });

  it('validates sensitive references before excluding them', () => {
    const bad = { ...reference('bad', { ...fileScope, resourceType: 'file_region', region: null }),
      sensitive: true };
    assert.throws(() => buildAssignmentContextPacket(contextInput({ memories: [bad] })), /region/i);
  });

  it('rejects malformed string lists', () => {
    assert.throws(() => buildAssignmentContextPacket(contextInput({ constraints: [''] })), /non-empty/);
  });

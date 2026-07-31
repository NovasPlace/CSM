import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { claudeHookEndpoint } from '../src/claude-hook-relay.js';
import { codexHookEndpoint } from '../src/codex-hook-relay.js';

/**
 * Concurrent-host transport isolation. The relay endpoint is derived from the
 * host pipe prefix plus a hash of the plugin root, so simultaneous Codex/Claude
 * sessions and multiple Claude workspaces never share a transport, while a given
 * (host, root) pair is stable across process restarts.
 */
describe('Claude transport isolation', () => {
  it('gives Codex and Claude distinct pipes at the same root', () => {
    const root = 'C:/work/project-a';
    assert.notEqual(claudeHookEndpoint(root), codexHookEndpoint(root));
  });

  it('gives distinct Claude workspaces distinct pipes', () => {
    assert.notEqual(claudeHookEndpoint('C:/work/project-a'), claudeHookEndpoint('C:/work/project-b'));
  });

  it('is deterministic for a given host and root (survives restart)', () => {
    assert.equal(claudeHookEndpoint('C:/work/project-a'), claudeHookEndpoint('C:/work/project-a'));
  });

  it('is case-insensitive on the root, matching the runtime hashing', () => {
    assert.equal(claudeHookEndpoint('C:/Work/Project-A'), claudeHookEndpoint('c:/work/project-a'));
  });

  it('always carries the Claude pipe prefix', () => {
    assert.match(claudeHookEndpoint('/x'), /csm-claude-[0-9a-f]{16}/u);
  });
});

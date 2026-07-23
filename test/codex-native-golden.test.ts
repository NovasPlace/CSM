import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { codexHookEndpoint } from '../src/codex-hook-relay.js';
import { toCodexHookOutput } from '../src/codex-hook-output.js';
import { CODEX_NATIVE_TOOL_NAMES } from '../src/codex-native-tool-catalog.js';

/**
 * Golden parity oracle for the Codex-native path. Captured BEFORE the HostProfile
 * seam is introduced. These assertions must remain byte-identical after the seam:
 * the invariant is behavioral (transport name, emitted wire payloads, tool catalog),
 * not source identity. If any of these change, the Codex host contract has drifted.
 */

// sha256('/csm/golden/root').slice(0,16) — frozen.
const GOLDEN_ROOT = '/csm/golden/root';
const GOLDEN_DIGEST = '95aef070f3d7925b';

const LIFECYCLE_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest',
  'PostToolUse', 'PreCompact', 'PostCompact', 'SubagentStart',
  'SubagentStop', 'Stop',
] as const;

describe('Codex native golden parity', () => {
  it('freezes the hook relay transport name', () => {
    const endpoint = codexHookEndpoint(GOLDEN_ROOT);
    const expected = process.platform === 'win32'
      ? `\\\\.\\pipe\\csm-codex-${GOLDEN_DIGEST}`
      : join(tmpdir(), `csm-codex-${GOLDEN_DIGEST}.sock`);
    assert.equal(endpoint, expected);
    assert.match(endpoint, /csm-codex-/u);
  });

  it('freezes the model-visible context wire format', () => {
    const message = '<agent_reentry_context>CSM continuity</agent_reentry_context>';
    assert.deepEqual(toCodexHookOutput({ continue: true, systemMessage: message }, 'SessionStart'), {
      continue: true,
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: message },
    });
    assert.deepEqual(toCodexHookOutput({ continue: true, systemMessage: message }, 'UserPromptSubmit'), {
      continue: true,
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: message },
    });
    assert.deepEqual(toCodexHookOutput({ continue: true, systemMessage: message }, 'PostToolUse'), {
      continue: true,
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message },
    });
  });

  it('freezes the deny/control wire format', () => {
    assert.deepEqual(toCodexHookOutput({ continue: true, systemMessage: 'deny reason' }, 'PreToolUse'), {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'deny reason',
      },
    });
    assert.deepEqual(toCodexHookOutput({ continue: true, systemMessage: 'blocked' }, 'PermissionRequest'), {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'blocked' },
      },
    });
  });

  it('freezes passthrough for non-context lifecycle events', () => {
    // Stop / SubagentStop / PreCompact / PostCompact retain a plain systemMessage.
    assert.deepEqual(toCodexHookOutput({ continue: true, systemMessage: 'note' }, 'Stop'), {
      continue: true, systemMessage: 'note',
    });
    assert.deepEqual(toCodexHookOutput({ continue: true }, 'Stop'), { continue: true });
    assert.deepEqual(toCodexHookOutput({ continue: true, systemMessage: 'snap' }, 'PreCompact'), {
      continue: true, systemMessage: 'snap',
    });
  });

  it('every lifecycle event round-trips without throwing and preserves continue where required', () => {
    for (const event of LIFECYCLE_EVENTS) {
      const output = toCodexHookOutput({ continue: true }, event);
      // PreToolUse and PermissionRequest strip `continue`; all others keep it.
      const stripsContinue = event === 'PreToolUse' || event === 'PermissionRequest';
      assert.equal(output.continue, stripsContinue ? undefined : true, event);
    }
  });

  it('freezes the native tool catalog surface', () => {
    assert.equal(CODEX_NATIVE_TOOL_NAMES.length, 51);
    assert.equal(new Set(CODEX_NATIVE_TOOL_NAMES).size, 51);
  });
});

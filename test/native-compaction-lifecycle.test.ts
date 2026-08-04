import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CodexNativeRuntime } from '../dist/codex-native-runtime.js';
import { nativeCompactionClientKind } from '../dist/hooks/native-compaction.js';
import { HERMES_HOST_PROFILE } from '../dist/native-host-profile.js';
import type { ToolCallRecord } from '../src/types.js';

function runtimeForBuffer(): CodexNativeRuntime {
  return Reflect.construct(CodexNativeRuntime, [
    'C:/projects/csm',
    {},
    {},
    {},
    HERMES_HOST_PROFILE,
  ]) as CodexNativeRuntime;
}

describe('native compaction tool-call buffering', () => {
  it('attributes each supported native host instead of collapsing non-Codex hosts', () => {
    assert.equal(nativeCompactionClientKind('codex'), 'codex');
    assert.equal(nativeCompactionClientKind('claude'), 'claude');
    assert.equal(nativeCompactionClientKind('hermes'), 'hermes');
  });

  it('snapshots without deleting fresh records and replaces only after an outcome', () => {
    const runtime = runtimeForBuffer();
    const record: ToolCallRecord = {
      tool: 'read_file',
      output: 'x'.repeat(500),
      timestamp: Date.now(),
      sessionId: 'session-a',
    };

    runtime.bufferToolCall('session-a', record);

    assert.deepEqual(runtime.snapshotToolCalls('session-a'), [record]);
    assert.deepEqual(runtime.snapshotToolCalls('session-a'), [record]);

    runtime.replaceToolCalls('session-a', []);
    assert.deepEqual(runtime.snapshotToolCalls('session-a'), []);
  });
});

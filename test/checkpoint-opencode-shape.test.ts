import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { buildCheckpoint } from '../dist/checkpoint-builder.js';
import type { CheckpointConfig, SessionMessage } from '../dist/checkpoint-types.js';

const CONFIG: CheckpointConfig = {
  enabled: true,
  maxCheckpointInjectTokens: 1200,
  minMessagesBeforeInject: 1,
  maxRawCaptureBytes: 8192,
  maxRawCapturesPerCheckpoint: 50,
};

describe('checkpoint OpenCode message compatibility', () => {
  it('captures completed and failed tool results from state.output/state.error using callID', () => {
    const messages: SessionMessage[] = [{
      info: { id: 'message-1', role: 'assistant' },
      parts: [
        {
          id: 'part-1',
          sessionID: 'session-1',
          messageID: 'message-1',
          type: 'tool',
          callID: 'call-completed',
          tool: 'read',
          state: {
            status: 'completed',
            input: { filePath: 'src/a.ts' },
            output: 'actual file contents',
            time: { start: 1, end: 2 },
          },
        },
        {
          id: 'part-2',
          sessionID: 'session-1',
          messageID: 'message-1',
          type: 'tool',
          callID: 'call-error',
          tool: 'bash',
          state: {
            status: 'error',
            input: { command: 'exit 1' },
            error: 'command failed badly',
            time: { start: 3, end: 4 },
          },
        },
      ],
    }];

    const result = buildCheckpoint({
      sessionId: 'session-1',
      projectId: null,
      messages,
      config: CONFIG,
    }).checkpoint;

    deepStrictEqual(result.sourceRefs.map(ref => ref.toolCallId), ['call-completed', 'call-error']);
    deepStrictEqual(result.sourceRefs.map(ref => ref.partId), ['part-1', 'part-2']);
    strictEqual(result.rawCaptures.length, 2);
    strictEqual(result.rawCaptures[0].toolCallId, 'call-completed');
    strictEqual(result.rawCaptures[0].content, 'actual file contents');
    strictEqual(result.rawCaptures[1].toolCallId, 'call-error');
    strictEqual(result.rawCaptures[1].content, 'command failed badly');
  });

  it('preserves TOOL_REF markers that appear inside real tool state output', () => {
    const messages: SessionMessage[] = [{
      info: { id: 'message-2', role: 'assistant' },
      parts: [{
        id: 'part-ref',
        type: 'tool',
        callID: 'call-ref',
        tool: 'read',
        state: {
          status: 'completed',
          output: 'TOOL_REF read({"filePath":"old.ts"}) prior output',
          time: { start: 5, end: 6, compacted: 7 },
        },
      }],
    }];

    const result = buildCheckpoint({
      sessionId: 'session-1',
      projectId: null,
      messages,
      config: CONFIG,
    }).checkpoint;

    strictEqual(result.compactedRefs.length, 1);
    ok(result.compactedRefs[0].marker.startsWith('TOOL_REF'));
    strictEqual(result.compactedRefs[0].toolCallId, 'call-ref');
    strictEqual(result.compactedRefs[0].partId, 'part-ref');
  });
});

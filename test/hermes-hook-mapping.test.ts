import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EVENT_MAP,
  buildCanonicalPayload,
  mapHermesEvent,
  translateResponse,
} from '../src/hermes-hook-mapping.js';
import { HERMES_HOST_PROFILE } from '../src/native-host-profile.js';

/**
 * Hermes ↔ CSM hook translation. Mirrors the golden-parity style of
 * test/codex-native-golden.test.ts: these assertions lock the event-name
 * mapping, the `extra`→top-level field remapping, and the Hermes response
 * shaping (context injection on pre_llm_call, block on pre_tool_call) so the
 * Hermes host contract cannot drift silently.
 */

describe('Hermes hook event mapping', () => {
  it('maps every wired Hermes event to its CSM canonical event', () => {
    assert.equal(mapHermesEvent('on_session_start'), 'SessionStart');
    assert.equal(mapHermesEvent('on_session_reset'), 'SessionStart');
    assert.equal(mapHermesEvent('pre_llm_call'), 'UserPromptSubmit');
    assert.equal(mapHermesEvent('pre_tool_call'), 'PreToolUse');
    assert.equal(mapHermesEvent('post_tool_call'), 'PostToolUse');
    assert.equal(mapHermesEvent('post_llm_call'), 'Stop');
    assert.equal(mapHermesEvent('subagent_start'), 'SubagentStart');
    assert.equal(mapHermesEvent('subagent_stop'), 'SubagentStop');
  });

  it('leaves observer-only Hermes events unmapped (pass-through no-ops)', () => {
    for (const event of ['on_session_end', 'on_session_finalize', 'pre_verify', 'pre_api_request', 'post_api_request']) {
      assert.equal(mapHermesEvent(event), undefined);
      assert.equal(EVENT_MAP[event], undefined);
    }
  });
});

describe('Hermes canonical payload building', () => {
  it('rewrites the event name and remaps extra kwargs to top-level CSM fields', () => {
    const payload = buildCanonicalPayload({
      hook_event_name: 'pre_llm_call',
      session_id: 'sess_1',
      cwd: '/work/proj',
      extra: {
        user_message: 'hello hermes',
        model: 'anthropic/claude-opus-4.6',
        task_id: 'turn_42',
        tool_call_id: 'call_7',
      },
    }, 'UserPromptSubmit');

    assert.equal(payload.hook_event_name, 'UserPromptSubmit');
    assert.equal(payload.session_id, 'sess_1');
    assert.equal(payload.cwd, '/work/proj');
    assert.equal(payload.prompt, 'hello hermes');
    assert.equal(payload.user_prompt, 'hello hermes');
    assert.equal(payload.model, 'anthropic/claude-opus-4.6');
    assert.equal(payload.turn_id, 'turn_42');
    assert.equal(payload.tool_use_id, 'call_7');
  });

  it('surfaces the tool result for post_tool_call from extra.result', () => {
    const payload = buildCanonicalPayload({
      hook_event_name: 'post_tool_call',
      tool_name: 'terminal',
      tool_input: { command: 'ls' },
      session_id: 'sess_1',
      cwd: '/work/proj',
      extra: { result: '{"exit":0}', task_id: 'turn_1' },
    }, 'PostToolUse');

    assert.equal(payload.hook_event_name, 'PostToolUse');
    assert.equal(payload.tool_response, '{"exit":0}');
    assert.equal(payload.turn_id, 'turn_1');
  });

  it('falls back to process cwd and the Hermes default session id when omitted', () => {
    const payload = buildCanonicalPayload({
      hook_event_name: 'on_session_end',
    }, 'Stop');

    assert.equal(payload.cwd, process.cwd());
    assert.equal(payload.session_id, HERMES_HOST_PROFILE.defaultSessionId);
  });
});

describe('Hermes response translation', () => {
  it('injects context on pre_llm_call when the relay returns a systemMessage', () => {
    const out = translateResponse(JSON.stringify({ continue: true, systemMessage: 'Recalled: …' }), 'pre_llm_call');
    assert.deepEqual(JSON.parse(out), { context: 'Recalled: …' });
  });

  it('emits an empty no-op on pre_llm_call when there is nothing to inject', () => {
    assert.equal(translateResponse(JSON.stringify({ continue: true }), 'pre_llm_call'), '{}');
    assert.equal(translateResponse('', 'pre_llm_call'), '{}');
  });

  it('blocks a pre_tool_call deny and stays silent otherwise', () => {
    const blocked = translateResponse(JSON.stringify({ systemMessage: 'forbidden' }), 'pre_tool_call');
    assert.deepEqual(JSON.parse(blocked), { action: 'block', message: 'forbidden' });
    assert.equal(translateResponse(JSON.stringify({ continue: true }), 'pre_tool_call'), '{}');
  });

  it('ignores the relay response for observer-only events', () => {
    const relayed = JSON.stringify({ continue: true, systemMessage: 'ignored by Hermes' });
    assert.equal(translateResponse(relayed, 'on_session_start'), '{}');
    assert.equal(translateResponse(relayed, 'post_tool_call'), '{}');
    assert.equal(translateResponse(relayed, 'subagent_stop'), '{}');
  });

  it('falls back to hookSpecificOutput.additionalContext for context injection', () => {
    const out = translateResponse(
      JSON.stringify({ continue: true, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'via hookSpecificOutput' } }),
      'pre_llm_call',
    );
    assert.deepEqual(JSON.parse(out), { context: 'via hookSpecificOutput' });
  });
});

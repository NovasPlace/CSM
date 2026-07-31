/**
 * Pure Hermes ↔ CSM hook translation logic.
 *
 * Extracted from the Hermes hook client so the event-name mapping, field
 * remapping, and response shaping are unit-testable without stdin/stdout or a
 * live relay. See `src/cli/hermes-hook-client.ts` for the I/O shell.
 *
 * Wire-format references:
 *  - Hermes shell hooks: hermes-agent/website/docs/user-guide/features/hooks.md
 *    (stdin payload uses `hook_event_name`, `tool_name`, `tool_input`,
 *    `session_id`, `cwd`, and an `extra` dict of event-specific kwargs)
 *  - CSM canonical events: src/codex-native-hooks.ts (handleCodexNativeHook
 *    dispatches on `hook_event_name` = SessionStart | UserPromptSubmit |
 *    PreToolUse | PostToolUse | Stop | SubagentStart | SubagentStop | …)
 */
import { HERMES_HOST_PROFILE } from './native-host-profile.js';

export interface HermesHookPayload {
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  extra?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export type RelayOutput = Record<string, unknown> & {
  continue?: unknown;
  systemMessage?: unknown;
  hookSpecificOutput?: Record<string, unknown> | null;
};

/**
 * Hermes event name → CSM canonical event name.
 * Unlisted events are pass-through no-ops (the client emits `{}` without
 * calling the relay).
 */
export const EVENT_MAP: Record<string, string> = {
  on_session_start: 'SessionStart',
  on_session_reset: 'SessionStart',
  pre_llm_call: 'UserPromptSubmit',
  pre_tool_call: 'PreToolUse',
  post_tool_call: 'PostToolUse',
  post_llm_call: 'Stop',
  subagent_start: 'SubagentStart',
  subagent_stop: 'SubagentStop',
};

/** Returns the CSM canonical event for a Hermes event, or undefined to skip. */
export function mapHermesEvent(hermesEvent: string): string | undefined {
  return EVENT_MAP[hermesEvent];
}

/**
 * Translate a Hermes hook payload into CSM's canonical payload shape. Hermes
 * carries event-specific kwargs under `extra`; CSM reads them as top-level
 * fields. `cwd`/`session_id` fall back to the process cwd and the Hermes
 * profile default so session-lifecycle events (which omit cwd) still satisfy
 * the relay's required-field contract.
 */
export function buildCanonicalPayload(payload: HermesHookPayload, canonicalEvent: string): HermesHookPayload {
  const extra = (payload.extra && typeof payload.extra === 'object' ? payload.extra : {}) as Record<string, unknown>;
  const result: HermesHookPayload = { ...payload, hook_event_name: canonicalEvent };
  result.cwd = stringValue(payload.cwd) ?? process.cwd();
  result.session_id = stringValue(payload.session_id) ?? HERMES_HOST_PROFILE.defaultSessionId;
  const prompt = stringValue(payload.prompt) ?? stringValue(extra.user_message);
  result.prompt = prompt;
  result.user_prompt = prompt;
  result.model = stringValue(payload.model) ?? stringValue(extra.model);
  result.turn_id = stringValue(payload.turn_id) ?? stringValue(extra.task_id);
  result.tool_use_id = stringValue(payload.tool_use_id) ?? stringValue(extra.tool_call_id);
  result.tool_response = payload.tool_response ?? extra.result ?? extra.response;
  return result;
}

/**
 * Shape the relay's host-neutral response for Hermes's wire format.
 *  - pre_llm_call: CSM's systemMessage → `{"context": "..."}` (empty `{}` when
 *    there is nothing to inject). Hermes injects context only here.
 *  - pre_tool_call: a deny systemMessage → `{"action": "block", "message": ...}`.
 *  - all other events: Hermes ignores the return value, so emit `{}`.
 */
export function translateResponse(relaySource: string, hermesEvent: string): string {
  const parsed: RelayOutput = relaySource.trim() ? JSON.parse(relaySource) as RelayOutput : {};
  const message = stringValue(parsed.systemMessage)
    ?? (parsed.hookSpecificOutput ? stringValue(parsed.hookSpecificOutput.additionalContext) : undefined);

  if (hermesEvent === 'pre_llm_call') {
    return message ? JSON.stringify({ context: message }) : '{}';
  }
  if (hermesEvent === 'pre_tool_call' && message) {
    return JSON.stringify({ action: 'block', message });
  }
  return '{}';
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

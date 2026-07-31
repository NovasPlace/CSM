const CONTEXT_EVENTS = new Set([
  'SessionStart',
  'SubagentStart',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
]);

const NO_COMMON_CONTROL_EVENTS = new Set(['PreToolUse', 'PermissionRequest']);

type HookOutput = Record<string, unknown> & {
  continue?: boolean;
  systemMessage?: unknown;
};

/** Convert the runtime's host-neutral hook result into Codex's current hook wire format. */
export function toCodexHookOutput(output: HookOutput, event: string): HookOutput {
  const result = { ...output };
  const message = typeof result.systemMessage === 'string' && result.systemMessage.trim()
    ? result.systemMessage.trim()
    : undefined;

  if (NO_COMMON_CONTROL_EVENTS.has(event)) delete result.continue;
  if (!message) return result;

  if (event === 'PermissionRequest') {
    delete result.systemMessage;
    result.hookSpecificOutput = {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny', message },
    };
    return result;
  }

  if (event === 'PreToolUse') {
    delete result.systemMessage;
    result.hookSpecificOutput = {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: message,
    };
    return result;
  }

  if (CONTEXT_EVENTS.has(event)) {
    delete result.systemMessage;
    result.hookSpecificOutput = {
      hookEventName: event,
      additionalContext: message,
    };
  }

  return result;
}

export function parseCodexHookOutput(source: string, event: string): string {
  const parsed = source.trim() ? JSON.parse(source) as HookOutput : {};
  return JSON.stringify(toCodexHookOutput(parsed, event));
}

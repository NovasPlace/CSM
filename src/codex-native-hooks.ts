import { createEventHook } from './hooks/event-hooks.js';
import { createAutocontinueHook, createSessionCompactingHook } from './hooks/session-compaction.js';
import { createSystemTransformHook } from './hooks/system-transform.js';
import {
  createPermissionAskHook,
  createToolExecuteAfterHook,
  createToolExecuteBeforeHook,
} from './hooks/tool-execute.js';
import { nativeCompactionClientKind, runNativeCompaction } from './hooks/native-compaction.js';
import type { CodexNativeRuntime, CodexNativeRuntimeManager } from './codex-native-runtime.js';

export type CodexHookPayload = Record<string, unknown> & {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string | null;
  cwd?: string;
  model?: string;
  turn_id?: string;
};

type CodexHookOutput = Record<string, unknown>;
const INITIALIZED = new WeakMap<CodexNativeRuntime, Set<string>>();

export async function handleCodexNativeHook(
  payload: CodexHookPayload,
  manager: CodexNativeRuntimeManager,
): Promise<CodexHookOutput> {
  const label = manager.profile.clientLabel;
  const projectRoot = requiredString(payload.cwd, 'cwd', label);
  const sessionId = requiredString(payload.session_id, 'session_id', label);
  const runtime = await manager.get(projectRoot);
  const event = stringValue(payload.hook_event_name) ?? 'unknown';
  runtime.setTranscriptPath(sessionId, stringValue(payload.transcript_path));
  runtime.context.syncActiveSession(sessionId);
  rememberModel(runtime, sessionId, stringValue(payload.model));

  if (event === 'SessionStart' || event === 'SubagentStart') {
    await initializeSession(runtime, sessionId);
    return contextOutput(await systemContext(runtime, sessionId));
  }
  if (event === 'UserPromptSubmit') {
    const prompt = stringValue(payload.prompt) ?? stringValue(payload.user_prompt) ?? '';
    if (prompt) runtime.context.state.recentUserMessages.set(sessionId, prompt);
    await captureMessageEvent(runtime, sessionId, 'user', stringValue(payload.turn_id));
    return contextOutput(await systemContext(runtime, sessionId, prompt));
  }
  if (event === 'PreToolUse') return preTool(runtime, payload, sessionId);
  if (event === 'PermissionRequest') return permission(runtime, payload, sessionId);
  if (event === 'PostToolUse') return postTool(runtime, payload, sessionId);
  if (event === 'PreCompact') return preCompact(runtime, payload, sessionId);
  if (event === 'PostCompact') return postCompact(runtime, payload, sessionId);
  if (event === 'Stop' || event === 'SubagentStop') {
    await captureMessageEvent(runtime, sessionId, 'assistant');
    await createEventHook(runtimeInput(runtime), runtime.context)({
      event: { type: 'session.updated', properties: { info: { id: sessionId } } },
    });
    // Keep fresh/retryable records across turn boundaries; only remove records
    // after the shared pipeline reports that they were safely compacted.
    const records = runtime.snapshotToolCalls(sessionId);
    if (records.length > 0) {
      const clientKind = nativeCompactionClientKind(runtime.profile.hostName);
      const outcome = await runNativeCompaction(runtime.context, records, sessionId, clientKind);
      runtime.replaceToolCalls(sessionId, outcome.retainedRecords);
    }
  }
  return { continue: true };
}

async function initializeSession(runtime: CodexNativeRuntime, sessionId: string): Promise<void> {
  let sessions = INITIALIZED.get(runtime);
  if (!sessions) {
    sessions = new Set();
    INITIALIZED.set(runtime, sessions);
  }
  if (sessions.has(sessionId)) return;
  await createEventHook(runtimeInput(runtime), runtime.context)({
    event: { type: 'session.created', properties: { info: { id: sessionId } } },
  });
  sessions.add(sessionId);
}

async function systemContext(
  runtime: CodexNativeRuntime,
  sessionId: string,
  prompt?: string,
): Promise<string> {
  const output = { system: [] as string[] };
  await createSystemTransformHook(runtime.context)(
    {
      sessionID: sessionId,
      model: { id: runtime.context.state.currentModelId ?? runtime.profile.hostName },
      messages: prompt ? [{ role: 'user', content: prompt }] : [],
    },
    output,
  );
  return output.system.join('\n\n');
}

async function preTool(
  runtime: CodexNativeRuntime,
  payload: CodexHookPayload,
  sessionId: string,
): Promise<CodexHookOutput> {
  const tool = toolName(payload);
  const callId = callIdValue(payload, runtime.profile.hostName);
  const output = { args: objectValue(payload.tool_input ?? payload.input) };
  try {
    await createToolExecuteBeforeHook(runtime.context)({ tool, sessionID: sessionId, callID: callId }, output);
    return {};
  } catch (error) {
    return { systemMessage: errorMessage(error) };
  }
}

async function permission(
  runtime: CodexNativeRuntime,
  _payload: CodexHookPayload,
  sessionId: string,
): Promise<CodexHookOutput> {
  const output: { status: 'ask' | 'deny' | 'allow' } = { status: 'ask' };
  await createPermissionAskHook(runtime.context)({ sessionID: sessionId }, output);
  return output.status === 'deny'
    ? { systemMessage: 'CSM re-entry source-only mode is active; deny this tool request.' }
    : {};
}

async function postTool(
  runtime: CodexNativeRuntime,
  payload: CodexHookPayload,
  sessionId: string,
): Promise<CodexHookOutput> {
  const tool = toolName(payload);
  const response = payload.tool_response ?? payload.tool_output ?? payload.response ?? '';
  const error = stringValue(payload.error);
  const args = objectValue(payload.tool_input ?? payload.input);
  const output = typeof response === 'string' ? response : JSON.stringify(response);
  await createToolExecuteAfterHook(runtime.context)(
    {
      tool,
      sessionID: sessionId,
      callID: callIdValue(payload, runtime.profile.hostName),
      args,
    },
    {
      title: tool,
      output,
      metadata: {
        error,
        exitCode: numberValue(payload.exit_code),
      },
    },
  );
  // Buffer for native compaction at Stop
  runtime.bufferToolCall(sessionId, {
    tool,
    args,
    output,
    error,
    exitCode: numberValue(payload.exit_code),
    timestamp: Date.now(),
    sessionId,
    toolCallId: callIdValue(payload, runtime.profile.hostName),
    filePath: extractFilePath(args),
  });
  return {};
}

async function preCompact(
  runtime: CodexNativeRuntime,
  _payload: CodexHookPayload,
  sessionId: string,
): Promise<CodexHookOutput> {
  const output: { context: string[]; prompt?: string } = { context: [] };
  await createSessionCompactingHook(runtime.context)({ sessionID: sessionId }, output);
  const context = [...output.context, output.prompt].filter((item): item is string => Boolean(item));
  return contextOutput(context.join('\n\n'));
}

async function postCompact(
  runtime: CodexNativeRuntime,
  payload: CodexHookPayload,
  sessionId: string,
): Promise<CodexHookOutput> {
  await createAutocontinueHook(runtime.context)(
    { sessionID: sessionId, overflow: stringValue(payload.trigger) === 'auto' },
    { enabled: true },
  );
  return contextOutput(await systemContext(runtime, sessionId));
}

async function captureMessageEvent(
  runtime: CodexNativeRuntime,
  sessionId: string,
  role: 'user' | 'assistant',
  preferredId?: string,
): Promise<void> {
  const messages = await runtime.transcriptMessages(sessionId);
  const message = [...messages].reverse().find((item) => item.info.role === role);
  if (!message && !preferredId) return;
  await createEventHook(runtimeInput(runtime), runtime.context)({
    event: {
      type: 'message.updated',
      properties: { info: { id: message?.info.id ?? preferredId, role, sessionID: sessionId } },
    },
  });
}

function contextOutput(systemMessage: string): CodexHookOutput {
  return systemMessage ? { continue: true, systemMessage } : { continue: true };
}

function rememberModel(runtime: CodexNativeRuntime, sessionId: string, model: string | undefined): void {
  if (!model || runtime.context.state.modelIdPinned) return;
  runtime.context.state.currentModelId = model;
  runtime.context.state.modelIdBySession?.set(sessionId, model);
}

function runtimeInput(runtime: CodexNativeRuntime) {
  return {
    client: runtime.context.client,
    directory: runtime.projectRoot,
    worktree: runtime.projectRoot,
  } as never;
}

function toolName(payload: CodexHookPayload): string {
  return stringValue(payload.tool_name) ?? stringValue(payload.tool) ?? 'unknown';
}

function callIdValue(payload: CodexHookPayload, hostName: string): string {
  return stringValue(payload.tool_use_id) ?? stringValue(payload.call_id)
    ?? stringValue(payload.turn_id) ?? `${hostName}-${Date.now()}`;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requiredString(value: unknown, name: string, label: string): string {
  const resolved = stringValue(value);
  if (!resolved) throw new Error(`${name} is required for the CSM ${label} hook.`);
  return resolved;
}

function extractFilePath(args: Record<string, unknown>): string | undefined {
  const path = args.filePath ?? args.path ?? args.file;
  return typeof path === 'string' ? path : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Phase 4A — checkpoint tool handlers
// Three tools: create_checkpoint, expand_checkpoint_ref, list_checkpoints
// Factories receive deps (client, store, config) — same closure pattern as memory tools.
import { tool } from '@opencode-ai/plugin/tool';
import { CheckpointStore } from './checkpoint-store.js';
import { buildCheckpoint, BuildResult } from './checkpoint-builder.js';
import { CheckpointConfig, CheckpointRecord, ExpandedRef, SessionMessage } from './checkpoint-types.js';
import { logCheckpointCreated, logCheckpointError } from './checkpoint-telemetry.js';

/** Minimal client interface — only the session.messages endpoint is used. */
interface SessionMessagesClient {
  session: {
    messages(input: { path: { id: string } }): Promise<{ data?: SdkMessage[] }>;
  };
}

/** Raw SDK message shape (camelCase from the OpenCode client API). */
interface SdkMessage {
  info?: { id?: string; role?: string; createdAt?: string };
  parts?: unknown[];
}

/** Dependencies injected from plugin init. */
export interface CheckpointToolDeps {
  client: SessionMessagesClient;
  store: CheckpointStore;
  config: CheckpointConfig;
  projectId: string | null;
}

type ToolResult = { title: string; output: string; metadata?: Record<string, unknown> };

/** Convert SDK message format to SessionMessage[]. */
function toSessionMessages(raw: SdkMessage[]): SessionMessage[] {
  return (raw ?? []).map((m: SdkMessage) => ({
    info: { id: m.info?.id, role: m.info?.role, created_at: m.info?.createdAt },
    parts: (m.parts ?? []) as SessionMessage['parts'],
  }));
}

/** Fetch session messages and validate minimum count. Returns null if too short. */
async function fetchMessages(deps: CheckpointToolDeps, sid: string): Promise<SessionMessage[] | ToolResult> {
  const resp = await deps.client.session.messages({ path: { id: sid } });
  const messages = toSessionMessages(resp.data ?? []);
  if (messages.length < deps.config.minMessagesBeforeInject) {
    return {
      title: 'Session too short',
      output: `Session has ${messages.length} messages. Need at least ${deps.config.minMessagesBeforeInject} to checkpoint.`,
      metadata: { messageCount: messages.length },
    };
  }
  return messages;
}

/** Build + store checkpoint, return record + built result. */
async function buildAndStore(deps: CheckpointToolDeps, sid: string, messages: SessionMessage[]) {
  const t0 = Date.now();
  const built = buildCheckpoint({ sessionId: sid, projectId: deps.projectId, messages, config: deps.config });
  const rec = await deps.store.createCheckpoint(built.checkpoint);
  logCheckpointCreated({
    sessionId: sid, checkpointId: rec.checkpointId, sourceMessages: messages.length,
    inputTokens: built.inputTokensEstimate, summaryTokens: rec.summaryTokens,
    refsPreserved: rec.sourceRefs.length + rec.compactedRefs.length,
    filesDetected: rec.filesMentioned.length, testsDetected: rec.testsMentioned.length,
    risksDetected: rec.risks.length, injectBudgetUsed: 0, elapsedMs: Date.now() - t0,
  });
  return { rec, built };
}

/** Format the create_checkpoint success result. */
function formatCreateResult(rec: CheckpointRecord, built: BuildResult): ToolResult {
  return {
    title: `Checkpoint created: ${rec.checkpointId.substring(0, 8)}`,
    output: rec.summaryMarkdown,
    metadata: {
      checkpointId: rec.checkpointId, summaryTokens: rec.summaryTokens,
      refsPreserved: rec.sourceRefs.length + rec.compactedRefs.length,
      filesDetected: rec.filesMentioned.length, risksDetected: rec.risks.length,
      nextSteps: rec.nextSteps, buildMs: built.buildMs,
    },
  };
}

/** /create_checkpoint — creates a durable session checkpoint. */
export function createCheckpointTool(deps: CheckpointToolDeps) {
  return tool({
    description: 'Create a durable checkpoint of the current session. Captures goal, decisions, files, tests, risks, and next steps. Stores raw tool outputs for later recovery via expand_checkpoint_ref.',
    args: {},
    async execute(_args, context) {
      if (!deps.config.enabled) return { title: 'Checkpoint disabled', output: 'Checkpoint feature is disabled in plugin config.' };
      try {
        const sid = context.sessionID;
        const fetched = await fetchMessages(deps, sid);
        if (!Array.isArray(fetched)) return fetched;
        const { rec, built } = await buildAndStore(deps, sid, fetched);
        return formatCreateResult(rec, built);
      } catch (error) {
        logCheckpointError('create', error);
        return { title: 'Checkpoint failed', output: `Failed to create checkpoint: ${error instanceof Error ? error.message : String(error)}`, metadata: { error: String(error) } };
      }
    },
  });
}

/** Format the expand_checkpoint_ref result. */
function formatExpandResult(result: ExpandedRef, refId: string): ToolResult {
  const lines: string[] = [];
  if (result.rawCapture) {
    lines.push(`Kind: ${result.rawCapture.kind}`);
    lines.push(`Tokens: ${result.rawCapture.tokenCount}`);
    if (result.rawCapture.messageId) lines.push(`Message: ${result.rawCapture.messageId}`);
    if (result.rawCapture.toolCallId) lines.push(`Tool call: ${result.rawCapture.toolCallId}`);
    lines.push('--- Content ---');
    lines.push(result.rawCapture.content);
  }
  if (result.compactedRef) {
    lines.push(`Compacted ref: ${result.compactedRef.marker}`);
    lines.push(`Hint: ${result.compactedRef.expandHint}`);
  }
  return {
    title: `Expanded: ${refId.substring(0, 24)}`,
    output: lines.join('\n'),
    metadata: { refId, found: true, kind: result.rawCapture?.kind },
  };
}

/** /expand_checkpoint_ref — recover original content from a checkpoint. */
export function expandCheckpointRefTool(deps: CheckpointToolDeps) {
  return tool({
    description: 'Expand a checkpoint reference to recover original tool output or assistant text. Use when you need details that were summarized in a checkpoint.',
    args: {
      refId: tool.schema.string().describe('The message ID, part ID, or tool call ID to expand'),
    },
    async execute(args, context) {
      if (!deps.config.enabled) return { title: 'Checkpoint disabled', output: 'Checkpoint feature is disabled.' };
      try {
        const result = await deps.store.expandRef(context.sessionID, args.refId);
        if (!result.found) return { title: 'Reference not found', output: `No raw capture found for ref: ${args.refId}`, metadata: { refId: args.refId, found: false } };
        return formatExpandResult(result, args.refId);
      } catch (error) {
        logCheckpointError('expand', error);
        return { title: 'Expand failed', output: `Error: ${error instanceof Error ? error.message : String(error)}`, metadata: { error: String(error) } };
      }
    },
  });
}

/** /list_checkpoints — list all checkpoints for the current session. */
export function listCheckpointsTool(deps: CheckpointToolDeps) {
  return tool({
    description: 'List all checkpoints for the current session. Shows checkpoint IDs, creation times, summary sizes, and file counts.',
    args: {},
    async execute(_args, context) {
      if (!deps.config.enabled) return { title: 'Checkpoint disabled', output: 'Checkpoint feature is disabled.' };
      try {
        const checkpoints = await deps.store.listCheckpoints(context.sessionID, 20);
        if (checkpoints.length === 0) return { title: 'No checkpoints', output: 'No checkpoints found for this session.' };
        const lines = checkpoints.map(c =>
          `[${c.isActive ? 'ACTIVE' : 'old'}] ${c.checkpointId.substring(0, 8)} — ${c.createdAt.toISOString().substring(0, 19)} — ${c.summaryTokens}t — ${c.filesMentioned.length} files — ${c.risks.length} risks`
        );
        return { title: `${checkpoints.length} checkpoint(s)`, output: lines.join('\n'), metadata: { count: checkpoints.length } };
      } catch (error) {
        logCheckpointError('list', error);
        return { title: 'List failed', output: `Error: ${error instanceof Error ? error.message : String(error)}`, metadata: { error: String(error) } };
      }
    },
  });
}
